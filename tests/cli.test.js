import { execSync } from 'child_process';

describe('CLI basics', () => {
  it('displays version number', () => {
    const output = execSync('node dist/cli.js --version').toString();
    expect(output).toMatch(/\d+\.\d+\.\d+/);
  });

  it('displays help information', () => {
    const output = execSync('node dist/cli.js --help').toString();
    expect(output).toContain('Options:');
    expect(output).toContain('Commands:');
  });

  it('displays info when no command is provided', () => {
    const output = execSync('node dist/cli.js').toString();
    expect(output).toContain('LocalHero.ai');
    expect(output).toContain('Visit https://localhero.ai for more information');
  });

  // If these works the commands should be possible to trigger
  describe('command help texts', () => {
    it('login command help', () => {
      const output = execSync('node dist/cli.js login --help').toString();
      expect(output).toContain('Authenticate with LocalHero.ai');
    });

    it('init command help', () => {
      const output = execSync('node dist/cli.js init --help').toString();
      expect(output).toContain('Initialize a new LocalHero.ai project');
    });

    it('translate command help', () => {
      const output = execSync('node dist/cli.js translate --help').toString();
      expect(output).toContain('Translate missing keys');
    });

    it('sync command help', () => {
      const output = execSync('node dist/cli.js sync --help').toString();
      expect(output).toContain('Pull updates from LocalHero.ai');
    });
  });
});