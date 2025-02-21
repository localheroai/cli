import { execSync } from 'child_process';

describe('CLI basics', () => {
    test('displays version number', () => {
        const output = execSync('node src/cli.js --version').toString();
        expect(output).toMatch(/\d+\.\d+\.\d+/);
    });

    test('displays help information', () => {
        const output = execSync('node src/cli.js --help').toString();
        expect(output).toContain('Options:');
        expect(output).toContain('Commands:');
    });

    test('displays info when no command is provided', () => {
        const output = execSync('node src/cli.js').toString();
        expect(output).toContain('LocalHero.ai');
        expect(output).toContain('Visit https://localhero.ai for more information');
    });

    // If these works the commands should be possible to trigger
    describe('command help texts', () => {
        test('login command help', () => {
            const output = execSync('node src/cli.js login --help').toString();
            expect(output).toContain('Authenticate with LocalHero.ai');
        });

        test('init command help', () => {
            const output = execSync('node src/cli.js init --help').toString();
            expect(output).toContain('Initialize a new LocalHero.ai project');
        });

        test('translate command help', () => {
            const output = execSync('node src/cli.js translate --help').toString();
            expect(output).toContain('Translate missing keys');
        });

        test('sync command help', () => {
            const output = execSync('node src/cli.js sync --help').toString();
            expect(output).toContain('Sync updates from LocalHero.ai');
        });
    });
}); 