import inquirer from 'inquirer';

export const defaultDependencies = {
    inquirer,
    console: global.console,
    basePath: process.cwd(),
}; 