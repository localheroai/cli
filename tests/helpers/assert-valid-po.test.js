import { assertValidPo } from './assert-valid-po.js';

const HEADER = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=utf-8\\n"
"Language: sv\\n"
`;

describe('assertValidPo', () => {
  it('passes for a well-formed file', () => {
    const content = `${HEADER}
#: src/App.jsx:1
msgid "Hello"
msgstr "Hej"
`;
    expect(() => assertValidPo(content)).not.toThrow();
  });

  it('catches the empty-msgid corruption bug', () => {
    // Exactly what the createPoFile bug produced: blank msgid, real msgstr.
    const content = `${HEADER}
msgid ""
msgstr "Hej"
`;
    expect(() => assertValidPo(content)).toThrow(/empty msgid/);
  });

  it('catches multiple empty-msgid entries', () => {
    const content = `${HEADER}
msgid ""
msgstr "Webbplats"

msgid ""
msgstr "Stäng"
`;
    expect(() => assertValidPo(content)).toThrow(/empty msgid/);
  });

  it('accepts the single legitimate header msgid ""', () => {
    const content = `${HEADER}
msgid "Save"
msgstr "Spara"
`;
    expect(() => assertValidPo(content)).not.toThrow();
  });

  it('catches duplicate msgid+msgctxt', () => {
    const content = `${HEADER}
msgid "Save"
msgstr "Spara"

msgid "Save"
msgstr "Lagra"
`;
    expect(() => assertValidPo(content)).toThrow(/duplicate/);
  });

  it('passes a plural entry with msgid_plural and forms', () => {
    const content = `${HEADER}"Plural-Forms: nplurals=2; plural=(n != 1);\\n"

msgid "one item"
msgid_plural "%d items"
msgstr[0] "en sak"
msgstr[1] "%d saker"
`;
    expect(() => assertValidPo(content)).not.toThrow();
  });

  it('throws on empty content', () => {
    expect(() => assertValidPo('')).toThrow(/empty/);
  });
});
