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
    },

    async selectProject(projectService) {
      const projects = await projectService.listProjects();

      if (!projects || projects.length === 0) {
        return { choice: 'new' };
      }

      const choices = [
        { name: '✨ Create new project', value: 'new' },
        { name: '─────────────', value: 'separator', disabled: true },
        ...projects.map(p => ({
          name: p.name,
          value: p.id
        }))
      ];

      const projectChoice = await this.select({
        message: 'Would you like to use an existing project or create a new one?',
        choices
      });

      return {
        choice: projectChoice,
        project: projects.find(p => p.id === projectChoice)
      };
    }
  };
}