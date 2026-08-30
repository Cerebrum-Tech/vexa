import { parse } from "acorn";
import * as walk from "acorn-walk";
import { transform } from "sucrase";

export type ValidationResult = { ok: true; errors: [] } | { ok: false; errors: string[] };

const ALLOWED_IMPORTS = new Set([
  "react",
  "@vexa/meeting-canvas",
  "@vexa/meeting-canvas/kit",
  "@vexa/meeting-canvas/hooks",
  "./kit",
  "./hooks",
  "./actions",
  "../canvas/kit",
  "../canvas/hooks",
  "../canvas/actions",
]);

const FORBIDDEN_IDENTIFIERS = new Set([
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "eval",
  "Function",
  "document",
  "window",
  "globalThis",
  "localStorage",
]);

type AnyNode = {
  type: string;
  start: number;
  end: number;
  loc?: { start: { line: number; column: number } };
  name?: string;
  value?: unknown;
  source?: { value?: unknown };
  [key: string]: unknown;
};

function location(node: AnyNode): string {
  return node.loc ? `satır ${node.loc.start.line}, sütun ${node.loc.start.column + 1}` : `konum ${node.start}`;
}

function add(errors: Map<string, string>, node: AnyNode, message: string): void {
  errors.set(`${message}@${location(node)}`, `${location(node)}: ${message}`);
}

function isNonComputedPropertyKey(node: AnyNode, parent: AnyNode | undefined): boolean {
  if (!parent) return false;
  if ((parent.type === "Property" || parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") && parent.key === node && !parent.computed) return true;
  if (parent.type === "MemberExpression" && parent.property === node && !parent.computed) return true;
  return false;
}

function transpileForParse(source: string): string {
  return transform(source, { transforms: ["typescript", "jsx"], jsxRuntime: "classic", production: false }).code;
}

export function validateViewSource(source: string): ValidationResult {
  const errors = new Map<string, string>();
  let code = "";
  let ast: AnyNode;
  try {
    code = transpileForParse(source);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, errors: [`Sucrase bu görünümü dönüştüremedi: ${msg}`] };
  }
  try {
    ast = parse(code, { ecmaVersion: "latest", sourceType: "module", locations: true, ranges: true }) as unknown as AnyNode;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, errors: [`Acorn dönüştürülen görünümü ayrıştıramadı: ${msg}`] };
  }

  walk.ancestor(ast as never, {
    ImportDeclaration(node: AnyNode) {
      const src = typeof node.source?.value === "string" ? node.source.value : "";
      if (!ALLOWED_IMPORTS.has(src)) add(errors, node, `"${src}" içe aktarılamaz. Yalnızca sağlanan genel değerleri kullanın: React, ui, useMeeting, useTranscript, useSpeakers, useEntities, useSignals, useMeetingDocs, useActions, actions, useState, useMemo, useEffect.`);
    },
    ExportNamedDeclaration(node: AnyNode) {
      add(errors, node, "Adlandırılmış dışa aktarımlar kullanılamaz. Tek bir varsayılan React bileşeni dışa aktarın.");
    },
    ExportAllDeclaration(node: AnyNode) {
      add(errors, node, "Tümünü dışa aktarma bildirimleri kullanılamaz. Tek bir varsayılan React bileşeni dışa aktarın.");
    },
    ImportExpression(node: AnyNode) {
      add(errors, node, "Toplantı görünümlerinde dinamik import() kullanılamaz.");
    },
    CallExpression(node: AnyNode) {
      const callee = node.callee as AnyNode | undefined;
      if (callee?.type === "Import") add(errors, node, "Toplantı görünümlerinde dinamik import() kullanılamaz.");
      if (callee?.type === "Identifier" && (callee.name === "eval" || callee.name === "Function")) add(errors, node, `Toplantı görünümlerinde ${callee.name}() kullanılamaz.`);
      const member = callee?.type === "MemberExpression" ? callee : null;
      const object = member?.object as AnyNode | undefined;
      const property = member?.property as AnyNode | undefined;
      const firstArg = (node.arguments as AnyNode[] | undefined)?.[0];
      if (object?.type === "Identifier" && object.name === "React" && property?.type === "Identifier" && property.name === "createElement" && firstArg?.type === "Literal" && typeof firstArg.value === "string") {
        add(errors, node, "Ham DOM öğeleri kullanılamaz. Yalnızca ui.* bileşenlerini kullanın.");
      }
    },
    NewExpression(node: AnyNode) {
      const callee = node.callee as AnyNode | undefined;
      if (callee?.type === "Identifier" && callee.name === "Function") add(errors, node, "Toplantı görünümlerinde new Function kullanılamaz.");
      if (callee?.type === "Identifier" && (callee.name === "XMLHttpRequest" || callee.name === "WebSocket")) add(errors, node, `new ${callee.name} kullanılamaz. Yalnızca sağlanan eylemleri ve toplantı verilerini kullanın.`);
    },
    Property(node: AnyNode) {
      const key = node.key as AnyNode | undefined;
      if (key?.type === "Identifier" && key.name === "dangerouslySetInnerHTML") add(errors, key, "dangerouslySetInnerHTML kullanılamaz.");
      if (key?.type === "Literal" && key.value === "dangerouslySetInnerHTML") add(errors, key, "dangerouslySetInnerHTML kullanılamaz.");
      if (key?.type === "Identifier" && (key.name === "style" || key.name === "className")) add(errors, key, `${key.name} kullanılamaz. Yalnızca kit'in tone/size/align özelliklerini kullanın.`);
      if (key?.type === "Literal" && (key.value === "style" || key.value === "className")) add(errors, key, `${String(key.value)} kullanılamaz. Yalnızca kit'in tone/size/align özelliklerini kullanın.`);
    },
    Identifier(node: AnyNode, ancestors: AnyNode[]) {
      const parent = ancestors[ancestors.length - 2];
      if (node.name === "dangerouslySetInnerHTML") {
        add(errors, node, "dangerouslySetInnerHTML kullanılamaz.");
        return;
      }
      if (isNonComputedPropertyKey(node, parent)) return;
      if (node.name && FORBIDDEN_IDENTIFIERS.has(node.name)) add(errors, node, `${node.name} toplantı görünümlerinde kullanılamaz.`);
    },
    Literal(node: AnyNode) {
      if (node.value === "dangerouslySetInnerHTML") add(errors, node, "dangerouslySetInnerHTML kullanılamaz.");
    },
  } as never);

  const list = [...errors.values()];
  return list.length ? { ok: false, errors: list } : { ok: true, errors: [] };
}

export const allowedImports = [...ALLOWED_IMPORTS];
