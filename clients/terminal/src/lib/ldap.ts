import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { Client, type Entry } from "ldapts";

/**
 * Corporate LDAP/LDAPS (Active Directory) authentication for the terminal's
 * sign-in card. A user types their domain account; the directory proves the
 * password, and the route above turns the resolved identity into a Vexa token.
 *
 * Flow: bind as the service account → search the configured OUs for the supplied
 * login name → re-bind as the resolved DN with the user's own password. Only the
 * second bind proves the password; the service bind only locates the entry.
 *
 * All configuration arrives as `LDAP_*` environment variables (P14) — no host,
 * DN, or password is ever a literal here. `LDAP_BIND_PASSWORD` and the CA bundle
 * are supplied at deploy time through the same env/secret source the rest of the
 * estate uses; nothing secret is committed.
 */

const GENERIC_CREDENTIALS_ERROR = "Kullanıcı adı veya şifre hatalı.";

const DEFAULT_SEARCH_FILTER =
  "(&(objectClass=user)(objectCategory=person)(|(sAMAccountName={{username}})(userPrincipalName={{username}})(mail={{username}})))";

const SEARCH_ATTRIBUTES = [
  "dn",
  "distinguishedName",
  "sAMAccountName",
  "userPrincipalName",
  "mail",
  "displayName",
  "givenName",
  "sn",
  "department",
  "title",
  "physicalDeliveryOfficeName",
  "company",
  "telephoneNumber",
  "userAccountControl",
];

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_OPERATION_TIMEOUT_MS = 10000;

/** Active Directory `userAccountControl` flag: account is disabled. */
const UAC_ACCOUNT_DISABLED = 0x0002;
/** Active Directory `userAccountControl` flag: account is locked out. */
const UAC_LOCKOUT = 0x0010;

/**
 * AD sub-codes carried inside an LDAP result-code-49 diagnostic message.
 * Surfaced so people know to change or renew a password instead of retrying the
 * same credentials until AD locks them out.
 */
const AD_SUBCODE_MESSAGES: Record<string, string> = {
  "525": "Kullanıcı bulunamadı.",
  "52e": GENERIC_CREDENTIALS_ERROR,
  "530": "Bu saatte oturum açma izniniz yok.",
  "531": "Bu iş istasyonundan oturum açma izniniz yok.",
  "532": "Şifrenizin süresi dolmuş. Lütfen domain şifrenizi yenileyin.",
  "533": "Hesabınız devre dışı bırakılmış.",
  "701": "Hesabınızın süresi dolmuş.",
  "773": "Giriş yapmadan önce şifrenizi değiştirmeniz gerekiyor.",
  "775": "Hesabınız kilitlenmiş. Lütfen BT ile iletişime geçin.",
};

/**
 * Raw Active Directory attributes read during the search. All optional because
 * AD only returns populated attributes.
 */
export interface LdapUserProfile {
  /** Distinguished name of the entry, used for the user bind. */
  dn: string;
  sAMAccountName?: string;
  userPrincipalName?: string;
  mail?: string;
  displayName?: string;
  givenName?: string;
  sn?: string;
  department?: string;
  title?: string;
  physicalDeliveryOfficeName?: string;
  company?: string;
  telephoneNumber?: string;
  /** Bit field carrying account state flags (disabled, locked, …). */
  userAccountControl?: number;
}

/**
 * An authentication failure with a message that is safe to show the user and an
 * HTTP status for the route to return. `reason` never reaches the client.
 */
export class LdapAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason: string,
  ) {
    super(message);
    this.name = "LdapAuthError";
  }
}

/**
 * Reports whether LDAP login is configured, so the login card can render the
 * domain form or hide it.
 */
export function isLdapEnabled(): boolean {
  const explicit = process.env.LDAP_ENABLED;
  if (explicit !== undefined && explicit.trim() !== "") {
    return explicit.trim().toLowerCase() === "true";
  }
  const urls = process.env.LDAP_URLS;
  return !!urls && urls.trim() !== "";
}

/**
 * Authenticates a login name and password against Active Directory.
 *
 * @param rawUsername - sAMAccountName, userPrincipalName or `INNOVA\user`.
 * @param password - The user's domain password.
 * @returns The directory entry of the authenticated account.
 * @throws LdapAuthError on bad credentials, unusable accounts, misconfiguration
 *   or when no domain controller can be reached.
 */
export async function authenticateWithLdap(
  rawUsername: string,
  password: string,
): Promise<LdapUserProfile> {
  if (!isLdapEnabled()) {
    throw new LdapAuthError("Domain girişi bu kurulumda etkin değil.", 500, "ldap_disabled");
  }

  const username = normalizeUsername(rawUsername);
  if (!username) {
    throw new LdapAuthError(GENERIC_CREDENTIALS_ERROR, 401, "empty_username");
  }

  // A simple bind with an empty password is an *unauthenticated* bind, which AD
  // answers with success — accepting it would authenticate anyone who knows a
  // username. Reject before touching the directory.
  if (!password || password.trim() === "") {
    throw new LdapAuthError(GENERIC_CREDENTIALS_ERROR, 401, "empty_password");
  }

  return authenticateAgainstDirectory(username, password);
}

/**
 * Tries every configured domain controller in order, failing over only on
 * connectivity errors — never on a rejected password.
 */
async function authenticateAgainstDirectory(
  username: string,
  password: string,
): Promise<LdapUserProfile> {
  const urls = getServerUrls();
  let lastConnectionError: Error | null = null;

  for (const url of urls) {
    try {
      return await authenticateAgainstServer(url, username, password);
    } catch (error) {
      // Credential rejections and misconfiguration are answered by every replica
      // identically — only connectivity failures are worth retrying.
      if (error instanceof LdapAuthError) throw error;
      lastConnectionError = error as Error;
      console.warn(`[LDAP] ${url} ulaşılamadı (${(error as Error).message}); sıradaki sunucu deneniyor`);
    }
  }

  console.error("[LDAP] Yapılandırılmış tüm sunucular başarısız", lastConnectionError);
  throw new LdapAuthError(
    "Domain servisine ulaşılamıyor. Lütfen daha sonra tekrar deneyin.",
    503,
    "server_unavailable",
  );
}

/** Runs the full bind-search-bind sequence against one domain controller. */
async function authenticateAgainstServer(
  url: string,
  username: string,
  password: string,
): Promise<LdapUserProfile> {
  const bindDn = requireConfig("LDAP_BIND_DN");
  const bindPassword = requireConfig("LDAP_BIND_PASSWORD");

  const serviceClient = createClient(url);
  let profile: LdapUserProfile;
  try {
    await serviceClient.bind(bindDn, bindPassword);
    const entry = await findUserEntry(serviceClient, username);
    if (!entry) {
      throw new LdapAuthError(GENERIC_CREDENTIALS_ERROR, 401, "user_not_found");
    }
    profile = mapEntryToProfile(entry);
  } catch (error) {
    if (isCredentialsError(error)) {
      // The *service account* was rejected — misconfiguration, not a user error.
      console.error("[LDAP] Servis hesabı bind edemedi; LDAP_BIND_DN / LDAP_BIND_PASSWORD kontrol edin");
      throw new LdapAuthError("Domain yapılandırması hatalı. Lütfen BT ile iletişime geçin.", 500, "service_account_rejected");
    }
    throw error;
  } finally {
    await safeUnbind(serviceClient);
  }

  assertAccountUsable(profile);

  const userClient = createClient(url);
  try {
    await userClient.bind(profile.dn, password);
  } catch (error) {
    if (isCredentialsError(error)) {
      throw new LdapAuthError(resolveCredentialsErrorMessage(error), 401, "invalid_credentials");
    }
    throw error;
  } finally {
    await safeUnbind(userClient);
  }

  return profile;
}

/** Searches every configured user search base for the given login name. */
async function findUserEntry(client: Client, username: string): Promise<Entry | null> {
  const filterTemplate = process.env.LDAP_USER_SEARCH_FILTER?.trim() || DEFAULT_SEARCH_FILTER;
  const filter = filterTemplate.replace(/\{\{username\}\}/g, escapeFilterValue(username));

  for (const searchBase of getSearchBases()) {
    const { searchEntries } = await client.search(searchBase, {
      scope: "sub",
      filter,
      attributes: SEARCH_ATTRIBUTES,
      timeLimit: 10,
    });
    if (searchEntries.length > 1) {
      console.warn(`[LDAP] "${username}" ${searchBase} altında ${searchEntries.length} kayıtla eşleşti; ilki kullanılıyor`);
    }
    if (searchEntries.length > 0) return searchEntries[0];
  }
  return null;
}

/**
 * Rejects accounts AD reports as disabled or locked, before a bind that would
 * only add another failure to the account's counter.
 */
function assertAccountUsable(profile: LdapUserProfile): void {
  const uac = profile.userAccountControl ?? 0;
  if ((uac & UAC_ACCOUNT_DISABLED) !== 0) {
    throw new LdapAuthError("Hesabınız devre dışı bırakılmış.", 401, "account_disabled");
  }
  if ((uac & UAC_LOCKOUT) !== 0) {
    throw new LdapAuthError("Hesabınız kilitlenmiş. Lütfen BT ile iletişime geçin.", 401, "account_locked");
  }
}

/**
 * Builds a configured LDAP client. TLS settings are applied only for `ldaps://`
 * URLs: ldapts treats the presence of `tlsOptions` as "negotiate TLS", so
 * passing them on a plain `ldap://` URL forces a handshake the server never
 * offers and the connection resets. Plain LDAP therefore gets no `tlsOptions`.
 */
function createClient(url: string): Client {
  const secure = url.trim().toLowerCase().startsWith("ldaps://");
  const rejectUnauthorized = process.env.LDAP_TLS_REJECT_UNAUTHORIZED?.trim().toLowerCase() !== "false";
  const ca = loadCaCertificates();

  return new Client({
    url,
    timeout: numberConfig("LDAP_TIMEOUT_MS", DEFAULT_OPERATION_TIMEOUT_MS),
    connectTimeout: numberConfig("LDAP_CONNECT_TIMEOUT_MS", DEFAULT_CONNECT_TIMEOUT_MS),
    ...(secure
      ? {
          tlsOptions: {
            rejectUnauthorized,
            ...(ca ? { ca } : {}),
          },
        }
      : {}),
  });
}

/** Lazily loaded PEM CA bundle for the LDAPS handshake. */
let cachedCaCertificates: string[] | null = null;

/**
 * Loads and caches the internal CA bundle that signs the LDAPS certificates.
 * Accepts both PEM and DER (`.cer`) encodings.
 */
function loadCaCertificates(): string[] | null {
  if (cachedCaCertificates) return cachedCaCertificates;

  const rawPaths = process.env.LDAP_TLS_CA_PATH?.trim();
  if (!rawPaths) return null;

  const certificates: string[] = [];
  for (const rawPath of rawPaths.split(",").map((item) => item.trim())) {
    if (!rawPath) continue;
    const filePath = isAbsolute(rawPath) ? rawPath : resolve(process.cwd(), rawPath);
    try {
      certificates.push(toPem(readFileSync(filePath)));
    } catch (error) {
      console.error(`[LDAP] CA sertifikası okunamadı (${filePath}): ${(error as Error).message}`);
    }
  }
  if (certificates.length === 0) return null;
  cachedCaCertificates = certificates;
  return certificates;
}

/** Converts a certificate buffer to PEM, wrapping DER-encoded input. */
function toPem(contents: Buffer): string {
  const asText = contents.toString("utf8");
  if (asText.includes("-----BEGIN CERTIFICATE-----")) return asText;
  const base64 = contents.toString("base64");
  const lines = base64.match(/.{1,64}/g) ?? [base64];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

/** The ordered list of domain controllers to try. */
function getServerUrls(): string[] {
  const urls = requireConfig("LDAP_URLS")
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url !== "");
  if (urls.length === 0) {
    throw new LdapAuthError("Domain yapılandırması eksik: LDAP_URLS boş.", 500, "ldap_urls_empty");
  }
  return urls;
}

/** The OUs to search, falling back to the directory base DN. */
function getSearchBases(): string[] {
  const configured = (process.env.LDAP_USER_SEARCH_BASES ?? "")
    .split(";")
    .map((base) => base.trim())
    .filter((base) => base !== "");
  return configured.length > 0 ? configured : [requireConfig("LDAP_BASE_DN")];
}

/** Strips domain qualifiers so `INNOVA\jdoe` and `jdoe` resolve identically. */
function normalizeUsername(rawUsername: string): string {
  const trimmed = (rawUsername ?? "").trim();
  const backslashIndex = trimmed.lastIndexOf("\\");
  const withoutDomain = backslashIndex === -1 ? trimmed : trimmed.slice(backslashIndex + 1);
  return withoutDomain.toLowerCase();
}

/** Escapes RFC 4515 special characters so a username cannot inject a filter. */
function escapeFilterValue(value: string): string {
  return value.replace(/[\\*()\0/]/g, (char) => {
    const hex = char.charCodeAt(0).toString(16).padStart(2, "0");
    return `\\${hex}`;
  });
}

/** Maps a raw directory entry onto the typed profile shape. */
function mapEntryToProfile(entry: Entry): LdapUserProfile {
  const read = (key: string): string | undefined => {
    const value = entry[key];
    if (value === undefined || value === null) return undefined;
    const first = Array.isArray(value) ? value[0] : value;
    if (first === undefined || first === null) return undefined;
    const asString = Buffer.isBuffer(first) ? first.toString("utf8") : String(first);
    return asString.trim() === "" ? undefined : asString.trim();
  };

  const uacRaw = read("userAccountControl");
  const uac = uacRaw ? Number.parseInt(uacRaw, 10) : undefined;

  return {
    dn: read("distinguishedName") ?? entry.dn,
    sAMAccountName: read("sAMAccountName"),
    userPrincipalName: read("userPrincipalName"),
    mail: read("mail"),
    displayName: read("displayName"),
    givenName: read("givenName"),
    sn: read("sn"),
    department: read("department"),
    title: read("title"),
    physicalDeliveryOfficeName: read("physicalDeliveryOfficeName"),
    company: read("company"),
    telephoneNumber: read("telephoneNumber"),
    userAccountControl: uac !== undefined && Number.isNaN(uac) ? undefined : uac,
  };
}

/**
 * Resolves the email used as the account key.
 * Order: `mail`, `userPrincipalName`, then `sAMAccountName@LDAP_EMAIL_DOMAIN`.
 */
export function resolveLdapEmail(profile: LdapUserProfile): string | null {
  const candidate = profile.mail ?? profile.userPrincipalName;
  if (candidate && candidate.includes("@")) {
    return candidate.toLowerCase().trim();
  }
  const domain = process.env.LDAP_EMAIL_DOMAIN?.trim().replace(/^@/, "");
  if (domain && profile.sAMAccountName) {
    return `${profile.sAMAccountName.toLowerCase()}@${domain.toLowerCase()}`;
  }
  return null;
}

/** Builds the name shown in the UI from directory attributes. */
export function resolveLdapDisplayName(profile: LdapUserProfile, fallback: string): string {
  const given = profile.givenName?.trim();
  const family = profile.sn?.trim();
  if (given && family) return `${given} ${family}`;
  const full = profile.displayName?.trim();
  if (full) return full;
  if (given) return given;
  return fallback;
}

/** Detects LDAP result code 49 (invalid credentials) across ldapts versions. */
function isCredentialsError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: number; name?: string };
  return candidate.code === 49 || candidate.name === "InvalidCredentialsError";
}

/** Translates an AD sub-code (e.g. `data 773`) into a user-facing message. */
function resolveCredentialsErrorMessage(error: unknown): string {
  const message = (error as { message?: string })?.message ?? "";
  const match = /data ([0-9a-f]{3})/i.exec(message);
  if (!match) return GENERIC_CREDENTIALS_ERROR;
  return AD_SUBCODE_MESSAGES[match[1].toLowerCase()] ?? GENERIC_CREDENTIALS_ERROR;
}

/** Closes a connection without letting teardown errors mask the result. */
async function safeUnbind(client: Client): Promise<void> {
  try {
    await client.unbind();
  } catch {
    // A failed unbind never changes whether the password was correct.
  }
}

function numberConfig(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/** Reads a required configuration value or fails with a 500. */
function requireConfig(key: string): string {
  const raw = process.env[key];
  if (!raw || raw.trim() === "") {
    throw new LdapAuthError("Domain yapılandırması eksik. Lütfen BT ile iletişime geçin.", 500, `missing_config:${key}`);
  }
  return raw.trim();
}
