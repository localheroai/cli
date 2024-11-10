import { jest } from '@jest/globals';
import { execSync } from 'child_process';

describe('CLI basics', () => {
    test('displays version number', () => {
        const output = execSync('node src/cli.js --version').toString();
        expect(output).toMatch(/\d+\.\d+\.\d+/);
    });

    test('displays help information', () => {
        const output = execSync('node src/cli.js --help').toString();
        expect(output).toContain('Options:');
    });

    test('displays info when no command is provided', () => {
        const output = execSync('node src/cli.js').toString();
        expect(output).toContain('LocalHero.ai');
        expect(output).toContain('Version:');
    });

    // Disabled for now, we don't want to make API calls in tests
    // test('responds to init command', () => {
    //     const output = execSync('node src/cli.js init').toString();
    //     expect(output).toContain('Let\'s set up configuration for your project');
    // });
}); 