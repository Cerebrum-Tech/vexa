import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { defaultBotName } from '../defaultBotName';

describe('defaultBotName', () => {
  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_DEFAULT_BOT_NAME;
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_DEFAULT_BOT_NAME;
  });

  it('returns the Innova meeting assistant name when env is unset', () => {
    expect(defaultBotName()).toBe('Innova Toplantı Asistanı');
  });

  it('reads env at call time', () => {
    expect(defaultBotName()).toBe('Innova Toplantı Asistanı');
    process.env.NEXT_PUBLIC_DEFAULT_BOT_NAME = 'MyBot';
    expect(defaultBotName()).toBe('MyBot');
    delete process.env.NEXT_PUBLIC_DEFAULT_BOT_NAME;
    expect(defaultBotName()).toBe('Innova Toplantı Asistanı');
  });

  it('trims whitespace', () => {
    process.env.NEXT_PUBLIC_DEFAULT_BOT_NAME = '  Assistant  ';
    expect(defaultBotName()).toBe('Assistant');
  });
});
