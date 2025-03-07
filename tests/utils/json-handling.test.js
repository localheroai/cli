import { jest } from '@jest/globals';

describe('JSON handling', () => {
    let mockFs;
    let detectJsonFormat;
    let flattenTranslations;
    let unflattenTranslations;
    let preserveJsonStructure;
    let updateTranslationFile;

    beforeEach(async () => {
        jest.resetModules();

        // Set NODE_ENV to test
        process.env.NODE_ENV = 'test';

        // Mock fs/promises module
        mockFs = {
            readFile: jest.fn(),
            writeFile: jest.fn(),
            mkdir: jest.fn()
        };

        // Mock the modules
        await jest.unstable_mockModule('fs/promises', () => mockFs);

        // Import the modules after mocking
        const filesModule = await import('../../src/utils/files.js');
        const updaterModule = await import('../../src/utils/translation-updater.js');

        detectJsonFormat = filesModule.detectJsonFormat;
        flattenTranslations = filesModule.flattenTranslations;
        unflattenTranslations = filesModule.unflattenTranslations;
        preserveJsonStructure = filesModule.preserveJsonStructure;
        updateTranslationFile = updaterModule.updateTranslationFile;

        // Suppress console warnings
        jest.spyOn(console, 'warn').mockImplementation(() => { });
    });

    afterEach(() => {
        // Reset NODE_ENV
        delete process.env.NODE_ENV;
        jest.clearAllMocks();
    });

    describe('detectJsonFormat', () => {
        it('detects flat format', () => {
            const obj = {
                'navbar.home': 'Home',
                'navbar.about': 'About',
                'footer.copyright': '© 2025'
            };
            expect(detectJsonFormat(obj)).toBe('flat');
        });

        it('detects nested format', () => {
            const obj = {
                navbar: {
                    home: 'Home',
                    about: 'About'
                },
                footer: {
                    copyright: '© 2025'
                }
            };
            expect(detectJsonFormat(obj)).toBe('nested');
        });

        it('detects deeply nested format', () => {
            const obj = {
                navbar: {
                    items: {
                        home: 'Home'
                    }
                }
            };
            expect(detectJsonFormat(obj)).toBe('nested');
        });

        it('detects mixed format', () => {
            const obj = {
                'navbar.home': 'Home',
                footer: {
                    copyright: '© 2025'
                }
            };
            expect(detectJsonFormat(obj)).toBe('mixed');
        });
    });

    describe('flattenTranslations', () => {
        it('flattens nested objects', () => {
            const nested = {
                navbar: {
                    home: 'Home',
                    about: 'About'
                },
                footer: {
                    copyright: '© 2025'
                }
            };

            const expected = {
                'navbar.home': 'Home',
                'navbar.about': 'About',
                'footer.copyright': '© 2025'
            };

            expect(flattenTranslations(nested)).toEqual(expected);
        });

        it('handles already flat objects', () => {
            const flat = {
                'navbar.home': 'Home',
                'navbar.about': 'About'
            };

            expect(flattenTranslations(flat)).toEqual(flat);
        });

        it('handles deeply nested objects', () => {
            const deeplyNested = {
                app: {
                    navbar: {
                        items: {
                            home: 'Home'
                        }
                    }
                }
            };

            const expected = {
                'app.navbar.items.home': 'Home'
            };

            expect(flattenTranslations(deeplyNested)).toEqual(expected);
        });
    });

    describe('unflattenTranslations', () => {
        it('unflattens flat objects', () => {
            const flat = {
                'navbar.home': 'Home',
                'navbar.about': 'About',
                'footer.copyright': '© 2025'
            };

            const expected = {
                navbar: {
                    home: 'Home',
                    about: 'About'
                },
                footer: {
                    copyright: '© 2025'
                }
            };

            expect(unflattenTranslations(flat)).toEqual(expected);
        });

        it('handles already nested objects', () => {
            const nested = {
                navbar: 'Home'
            };

            expect(unflattenTranslations(nested)).toEqual(nested);
        });

        it('handles deeply nested paths', () => {
            const flat = {
                'app.navbar.items.home': 'Home'
            };

            const expected = {
                app: {
                    navbar: {
                        items: {
                            home: 'Home'
                        }
                    }
                }
            };

            expect(unflattenTranslations(flat)).toEqual(expected);
        });
    });

    describe('preserveJsonStructure', () => {
        it('preserves flat structure', () => {
            const original = {
                'navbar.home': 'Home',
                'navbar.about': 'About'
            };

            const newTranslations = {
                'navbar.home': 'Accueil',
                'navbar.about': 'À propos'
            };

            expect(preserveJsonStructure(original, newTranslations, 'flat')).toEqual(newTranslations);
        });

        it('preserves nested structure', () => {
            const original = {
                navbar: {
                    home: 'Home',
                    about: 'About'
                }
            };

            const newTranslations = {
                'navbar.home': 'Accueil',
                'navbar.about': 'À propos'
            };

            const expected = {
                navbar: {
                    home: 'Accueil',
                    about: 'À propos'
                }
            };

            expect(preserveJsonStructure(original, newTranslations, 'nested')).toEqual(expected);
        });

        it('preserves mixed structure', () => {
            const original = {
                navbar: {
                    home: 'Home'
                },
                'footer.copyright': '© 2025'
            };

            const newTranslations = {
                'navbar.home': 'Accueil',
                'footer.copyright': '© 2025 Entreprise'
            };

            const expected = {
                navbar: {
                    home: 'Accueil'
                },
                'footer.copyright': '© 2025 Entreprise'
            };

            expect(preserveJsonStructure(original, newTranslations, 'mixed')).toEqual(expected);
        });
    });

    describe('updateTranslationFile', () => {
        it('handles JSON files', async () => {
            // This is a simplified test that just verifies the function doesn't throw
            // We're not testing the actual file operations since they're mocked
            const filePath = '/path/to/translations.json';
            const translations = {
                'navbar.home': 'Home',
                'navbar.about': 'About'
            };

            // Mock the file read to return a valid JSON
            mockFs.readFile.mockResolvedValue(JSON.stringify({
                navbar: {
                    home: 'Old Home'
                }
            }));

            await expect(updateTranslationFile(filePath, translations, 'en'))
                .resolves.not.toThrow();
        });
    });
}); 