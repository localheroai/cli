import path from 'path';

export function createPromptService(deps = {}) {
    const { inquirer = null } = deps;

    return {
        async getApiKey() {
            if (!inquirer) return '';
            return inquirer.password({
                message: 'API Key:',
                mask: '*'
            });
        },

        async getProjectSetup() {
            if (!inquirer) return {};

            return {
                projectName: '',
                sourceLocale: '',
                outputLocales: [],
                translationPath: '',
                ignorePaths: []
            };
        },

        async confirmLogin() {
            if (!inquirer) return { shouldLogin: false };
            const result = await inquirer.confirm({
                message: 'Would you like to login now?',
                default: true
            });
            return { shouldLogin: result };
        },

        async select(options) {
            if (!inquirer) return 'new';
            return inquirer.select(options);
        },

        async input(options) {
            if (!inquirer) return '';
            return inquirer.input(options);
        },

        async confirm(options) {
            if (!inquirer) return false;
            return inquirer.confirm(options);
        }
    };
} 