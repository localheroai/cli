import { createProject as apiCreateProject, listProjects as apiListProjects } from '../api/projects.js';

export const defaultProjectService = {
    async createProject({ name, sourceLocale, targetLocales }) {
        return apiCreateProject({ name, sourceLocale, targetLocales });
    },

    async listProjects() {
        return apiListProjects();
    }
}; 