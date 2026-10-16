import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { importGuard, leaveOutMovedCells } from '../../src/utils/import-guard.js';
import type { TargetChangeFile } from '../../src/utils/target-changes.js';

const CHECKOUT = 'aaaaaaa';
const NEWER_TIP = 'bbbbbbb';
const ACTIONS_ENV = {
  GITHUB_ACTIONS: 'true',
  GITHUB_HEAD_REF: 'feature/checkout',
  GITHUB_REPOSITORY: 'acme/shop',
  GITHUB_TOKEN: 'workflow-token'
};

type TipFiles = Record<string, Record<string, unknown> | null>;

function frFile(changes: TargetChangeFile['changes']): TargetChangeFile {
  return { path: 'config/locales/fr.yml', source_path: 'config/locales/en.yml', locale: 'fr', format: 'yml', changes };
}

function keys(files: TargetChangeFile[]): string[] {
  return files.flatMap(file => file.changes.map(change => `${file.locale}:${change.key}`));
}

describe('leaveOutMovedCells', () => {
  let log: jest.Mock;
  let git: jest.Mock<(args: string[]) => string>;
  let flatValuesAt: jest.Mock<any>;
  let fetchActionToken: jest.Mock<any>;
  let tipHead: string;
  let tipFiles: TipFiles;

  beforeEach(() => {
    log = jest.fn();
    tipHead = NEWER_TIP;
    tipFiles = {};
    git = jest.fn((args: string[]) => {
      if (args[0] === 'rev-parse') return args[1] === 'HEAD' ? CHECKOUT : tipHead;
      return '';
    });
    flatValuesAt = jest.fn((file: { path: string; locale: string }) => {
      const values = tipFiles[`${file.path}#${file.locale}`];
      if (values === undefined) throw new Error(`unexpected read of ${file.path}#${file.locale}`);
      return values;
    });
    fetchActionToken = jest.fn<any>().mockResolvedValue({ token: 'app-token' });
    importGuard.setDependencies({ env: { ...ACTIONS_ENV }, git, flatValuesAt, fetchActionToken });
  });

  function logged(): string {
    return log.mock.calls.map(call => String(call[0])).join('\n');
  }

  function guard(files: TargetChangeFile[]) {
    return leaveOutMovedCells(files, 'en', { log });
  }

  it('leaves out a value a sync changed after the checkout and imports the rest', async () => {
    tipFiles = {
      'config/locales/fr.yml#fr': { 'cart.title': 'Panier (relu)', 'cart.empty': 'Panier vide' }
    };

    const kept = await guard([frFile([
      { key: 'cart.title', status: 'updated', value: 'Panier', old_value: 'Le panier' },
      { key: 'cart.empty', status: 'added', value: 'Panier vide' }
    ])]);

    expect(keys(kept)).toEqual(['fr:cart.empty']);
    expect(logged()).toContain('Left out 1 value the branch changed after this run started; it is handled by the newer commit.');
    expect(flatValuesAt.mock.calls.map(call => call[1])).toEqual(['FETCH_HEAD']);
  });

  it('leaves out a value a second sync changed again', async () => {
    tipFiles = { 'config/locales/fr.yml#fr': { 'cart.title': 'Panier (C2)' } };

    const kept = await guard([frFile([{ key: 'cart.title', status: 'updated', value: 'Panier (C1)' }])]);

    expect(kept).toEqual([]);
    expect(logged()).toContain('Left out 1 value');
  });

  it('imports everything without reading files when the tip is the checkout', async () => {
    tipHead = CHECKOUT;
    const files = [frFile([{ key: 'cart.title', status: 'updated', value: 'Panier' }])];

    const kept = await guard(files);

    expect(kept).toEqual(files);
    expect(flatValuesAt).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('after a force-push, leaves out only the values the new history holds differently', async () => {
    tipFiles = { 'config/locales/fr.yml#fr': { 'a': 'same', 'b': 'rewritten' } };

    const kept = await guard([frFile([
      { key: 'a', status: 'added', value: 'same' },
      { key: 'b', status: 'added', value: 'ours' },
      { key: 'c', status: 'added', value: 'gone' }
    ])]);

    expect(keys(kept)).toEqual(['fr:a']);
    expect(logged()).toContain('Left out 2 values the branch changed after this run started; they are handled by the newer commit.');
  });

  it('leaves out an aligned value a sync changed after our commit', async () => {
    tipFiles = {
      'config/locales/fr.yml#fr': { 'profile.title': 'Votre profil (relu)', 'profile.hint': 'Votre astuce' },
      'config/locales/en.yml#en': { 'profile.title': 'Your profile', 'profile.hint': 'Your hint' }
    };

    const kept = await guard([frFile([
      { key: 'profile.title', status: 'updated', value: 'Votre profil', source_value: 'Your profile', aligned_source: 'Your profile' },
      { key: 'profile.hint', status: 'updated', value: 'Votre astuce', source_value: 'Your hint', aligned_source: 'Your hint' }
    ])]);

    expect(keys(kept)).toEqual(['fr:profile.hint']);
  });

  it('leaves out an unchanged target that carries source text a newer push replaced', async () => {
    tipFiles = {
      'config/locales/fr.yml#fr': { 'promo': 'Soldes' },
      'config/locales/en.yml#en': { 'promo': 'Big sale' }
    };

    const kept = await guard([frFile([{ key: 'promo', status: 'added', value: 'Soldes', source_value: 'Sale' }])]);

    expect(kept).toEqual([]);
  });

  it('leaves out an aligned value whose source text a newer push replaced', async () => {
    tipFiles = {
      'config/locales/fr.yml#fr': { 'promo': 'Grandes soldes' },
      'config/locales/en.yml#en': { 'promo': 'Huge sale' }
    };

    const kept = await guard([frFile([{ key: 'promo', status: 'updated', value: 'Grandes soldes', aligned_source: 'Big sale' }])]);

    expect(kept).toEqual([]);
  });

  it('leaves out a value whose source cell the tip lacks', async () => {
    tipFiles = {
      'config/locales/fr.yml#fr': { 'promo': 'Soldes' },
      'config/locales/en.yml#en': {}
    };

    const kept = await guard([frFile([{ key: 'promo', status: 'added', value: 'Soldes', source_value: 'Sale' }])]);

    expect(kept).toEqual([]);
  });

  it('reads each locale of a multi-language file separately', async () => {
    tipFiles = {
      'config/locales/multi.yml#sv': { 'greeting': 'Hej (relu)', 'bye': 'Hejdå' },
      'config/locales/multi.yml#en': { 'greeting': 'Hello', 'bye': 'Bye' }
    };
    const multi = (changes: TargetChangeFile['changes']): TargetChangeFile => (
      { path: 'config/locales/multi.yml', source_path: 'config/locales/multi.yml', locale: 'sv', format: 'yml', changes }
    );

    const kept = await guard([multi([
      { key: 'greeting', status: 'updated', value: 'Hej', source_value: 'Hello' },
      { key: 'bye', status: 'added', value: 'Hejdå', source_value: 'Bye' }
    ])]);

    expect(keys(kept)).toEqual(['sv:bye']);
  });

  it('compares PO values by their msgid key', async () => {
    tipFiles = { 'locale/sv/LC_MESSAGES/django.po#sv': { 'Hello': 'Hej', 'menu|Open': 'Öppna (relu)' } };
    const po: TargetChangeFile = {
      path: 'locale/sv/LC_MESSAGES/django.po',
      source_path: 'locale/en/LC_MESSAGES/django.po',
      locale: 'sv',
      format: 'po',
      changes: [
        { key: 'Hello', status: 'added', value: 'Hej' },
        { key: 'menu|Open', status: 'added', value: 'Öppna' }
      ]
    };

    expect(keys(await guard([po]))).toEqual(['sv:Hello']);
  });

  it('leaves out every value of a file the tip no longer has', async () => {
    tipFiles = { 'config/locales/fr.yml#fr': null };

    const kept = await guard([frFile([{ key: 'cart.title', status: 'added', value: 'Panier' }])]);

    expect(kept).toEqual([]);
  });

  it('leaves out every value of a file it cannot read at the tip', async () => {
    flatValuesAt.mockImplementation(() => { throw new Error('bad indentation'); });

    const kept = await guard([frFile([{ key: 'cart.title', status: 'added', value: 'Panier' }])]);

    expect(kept).toEqual([]);
  });

  it('compares values in the form Localhero stores them', async () => {
    tipFiles = { 'config/locales/fr.yml#fr': { 'two.lines': 'Ligne 1\r\nLigne 2', 'count': 3 } };

    const kept = await guard([frFile([
      { key: 'two.lines', status: 'added', value: 'Ligne 1\nLigne 2' },
      { key: 'count', status: 'added', value: '3' }
    ])]);

    expect(keys(kept)).toEqual(['fr:two.lines', 'fr:count']);
  });

  it('fetches the branch with the app token, through the URL and without a depth', async () => {
    tipHead = CHECKOUT;

    await guard([frFile([{ key: 'a', status: 'added', value: 'x' }])]);

    expect(git).toHaveBeenCalledWith(['fetch', '--no-tags', 'https://x-access-token:app-token@github.com/acme/shop.git', 'feature/checkout']);
  });

  it('falls back to the workflow token', async () => {
    tipHead = CHECKOUT;
    fetchActionToken.mockResolvedValue({ token: null, errorCode: 'github_app_not_installed' });

    await guard([frFile([{ key: 'a', status: 'added', value: 'x' }])]);

    expect(git.mock.calls[0][0][2]).toBe('https://x-access-token:workflow-token@github.com/acme/shop.git');
  });

  it('imports everything and warns once, with the token masked, when the fetch fails', async () => {
    git.mockImplementation((args: string[]) => {
      if (args[0] === 'fetch') throw new Error('Command failed: git fetch https://x-access-token:app-token@github.com/acme/shop.git: 403');
      return '';
    });
    const files = [frFile([{ key: 'a', status: 'added', value: 'x' }])];

    expect(await guard(files)).toEqual(files);
    expect(await guard(files)).toEqual(files);

    expect(log).toHaveBeenCalledTimes(1);
    expect(logged()).toContain('Could not check whether the branch moved during this run');
    expect(logged()).not.toContain('app-token');
  });

  it('imports everything and warns when there is no token to fetch with', async () => {
    fetchActionToken.mockResolvedValue({ token: null });
    importGuard.setDependencies({ env: { ...ACTIONS_ENV, GITHUB_TOKEN: undefined }, git, flatValuesAt, fetchActionToken });
    const files = [frFile([{ key: 'a', status: 'added', value: 'x' }])];

    expect(await guard(files)).toEqual(files);
    expect(logged()).toContain('Could not check whether the branch moved during this run');
  });

  it('does nothing outside GitHub Actions', async () => {
    importGuard.setDependencies({ env: {}, git, flatValuesAt, fetchActionToken });
    const files = [frFile([{ key: 'a', status: 'added', value: 'x' }])];

    expect(await guard(files)).toEqual(files);
    expect(git).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('does nothing in Actions when the run is not for a pull request branch', async () => {
    importGuard.setDependencies({ env: { ...ACTIONS_ENV, GITHUB_HEAD_REF: '' }, git, flatValuesAt, fetchActionToken });
    const files = [frFile([{ key: 'a', status: 'added', value: 'x' }])];

    expect(await guard(files)).toEqual(files);
    expect(git).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});
