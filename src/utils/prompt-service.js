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