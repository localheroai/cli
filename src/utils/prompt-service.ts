import { createPrompt, useState, useKeypress, usePrefix, isEnterKey } from '@inquirer/core';
import chalk from 'chalk';

/**
 * Prompt service for handling CLI interactions with the user
 */

/**
 * Options for select prompts
 */
export interface SelectOptions {
  message: string;
  choices: Array<{
    name: string;
    value: string;
    disabled?: boolean;
  }>;
}

/**
 * Options for input prompts
 */
export interface InputOptions {
  message: string;
  default?: string;
  hint?: string;
  transformer?: (input: string, answers?: any, flags?: any) => string;
}

/**
 * Options for confirmation prompts
 */
export interface ConfirmOptions {
  message: string;
  default?: boolean;
}

/**
 * Options for password prompts
 */
export interface PasswordOptions {
  message: string;
  mask?: string;
}

/**
 * Project setup information
 */
export interface ProjectSetup {
  projectName: string;
  sourceLocale: string;
  outputLocales: string[];
  translationPath: string;
  ignorePaths: string[];
}

/**
 * Project selection result
 */
export interface ProjectSelectionResult {
  choice: string;
  project?: {
    id: string;
    name: string;
    [key: string]: any;
  };
}

/**
 * Dependencies for the prompt service
 */
export interface PromptServiceDependencies {
  inquirer?: {
    password: (options: PasswordOptions) => Promise<string>;
    select: (options: SelectOptions) => Promise<string>;
    input: (options: InputOptions) => Promise<string>;
    confirm: (options: ConfirmOptions) => Promise<boolean>;
  } | null;
}

/**
 * Custom input prompt with hint support
 */
const inputWithHint = createPrompt<string, { message: string; hint?: string; default?: string }>((config, done) => {
  const [value, setValue] = useState(config.default || '');
  const [status, setStatus] = useState<'pending' | 'done'>('pending');
  const prefix = usePrefix({ status });

  useKeypress(async (key, rl) => {
    if (isEnterKey(key)) {
      const finalValue = value || config.default || '';
      setStatus('done');
      done(finalValue);
    } else {
      setValue(rl.line);
    }
  });

  const message = chalk.bold(config.message);
  const hint = config.hint ? `${chalk.dim(config.hint)}` : '';

  return [
    `${prefix} ${message} ${value}`,
    hint ? `${hint}` : ''
  ];
});

/**
 * Creates a prompt service for handling CLI interactions
 * @param deps Dependencies for the prompt service
 * @returns The prompt service object
 */
export function createPromptService(deps: PromptServiceDependencies = {}) {
  const { inquirer = null } = deps;

  return {
    /**
     * Prompts the user for an API key
     * @returns The API key entered by the user
     */
    async getApiKey(): Promise<string> {
      if (!inquirer) return '';
      return inquirer.password({
        message: 'API Key:',
        mask: '*'
      });
    },

    /**
     * Gets project setup information - defaults to empty values when inquirer is not available
     * @returns Project setup information
     */
    async getProjectSetup(): Promise<ProjectSetup> {
      if (!inquirer) return {
        projectName: '',
        sourceLocale: '',
        outputLocales: [],
        translationPath: '',
        ignorePaths: []
      };

      return {
        projectName: '',
        sourceLocale: '',
        outputLocales: [],
        translationPath: '',
        ignorePaths: []
      };
    },

    /**
     * Prompts the user with a selection
     * @param options Selection options
     * @returns The selected value
     */
    async select(options: SelectOptions): Promise<string> {
      if (!inquirer) return 'new';
      return inquirer.select(options);
    },

    /**
     * Prompts the user for text input
     * @param options Input options
     * @returns The entered text
     */
    async input(options: InputOptions): Promise<string> {
      if (!inquirer) return '';

      if (!options.hint) {
        return inquirer.input(options);
      }

      return inputWithHint({
        message: options.message,
        hint: options.hint,
        default: options.default
      });
    },

    /**
     * Prompts the user for confirmation
     * @param options Confirmation options
     * @returns True if confirmed, false otherwise
     */
    async confirm(options: ConfirmOptions): Promise<boolean> {
      if (!inquirer) return false;
      return inquirer.confirm(options);
    },

    /**
     * Prompts the user to select a project or create a new one
     * @param projectService Service providing project operations
     * @returns The selection result with the chosen project
     */
    async selectProject(projectService: { listProjects: () => Promise<Array<{ id: string; name: string }>> }): Promise<ProjectSelectionResult> {
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
