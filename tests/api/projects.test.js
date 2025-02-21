import { jest } from '@jest/globals';

describe('projects API', () => {
    let mockGetApiKey;
    let listProjects;
    let createProject;

    beforeEach(async () => {
        jest.resetModules();
        global.fetch = jest.fn();

        mockGetApiKey = jest.fn().mockResolvedValue('tk_123456789012345678901234567890123456789012345678');
        await jest.unstable_mockModule('../../src/utils/auth.js', () => ({
            getApiKey: mockGetApiKey
        }));

        const projectsModule = await import('../../src/api/projects.js');
        listProjects = projectsModule.listProjects;
        createProject = projectsModule.createProject;
    });

    describe('listProjects', () => {
        it('fetches projects list successfully', async () => {
            const mockResponse = {
                projects: [
                    {
                        id: 'proj_123',
                        name: 'Test Project',
                        source_language: 'en',
                        target_languages: ['fr', 'es']
                    }
                ]
            };

            global.fetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockResponse)
            });

            const result = await listProjects();

            expect(global.fetch).toHaveBeenCalledWith(
                'https://api.localhero.ai/api/v1/projects',
                {
                    method: 'GET',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer tk_123456789012345678901234567890123456789012345678'
                    }
                }
            );
            expect(result).toEqual(mockResponse.projects);
        });

        it('handles API errors', async () => {
            const errorResponse = {
                error: {
                    message: 'Failed to fetch projects'
                }
            };

            global.fetch.mockResolvedValueOnce({
                ok: false,
                status: 500,
                json: () => Promise.resolve(errorResponse)
            });

            await expect(listProjects()).rejects.toThrow('Failed to fetch projects');
        });
    });

    describe('createProject', () => {
        it('creates a project successfully', async () => {
            const projectData = {
                name: 'New Project',
                sourceLocale: 'en',
                targetLocales: ['fr', 'es']
            };
            const mockResponse = {
                project: {
                    id: 'proj_123',
                    name: projectData.name,
                    source_language: projectData.sourceLocale,
                    target_languages: projectData.targetLocales
                }
            };

            global.fetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockResponse)
            });

            const result = await createProject(projectData);

            expect(global.fetch).toHaveBeenCalledWith(
                'https://api.localhero.ai/api/v1/projects',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer tk_123456789012345678901234567890123456789012345678'
                    },
                    body: JSON.stringify({
                        project: {
                            name: projectData.name,
                            source_language: projectData.sourceLocale,
                            target_languages: projectData.targetLocales
                        }
                    })
                }
            );
            expect(result).toEqual(mockResponse.project);
        });

        it('handles project creation errors', async () => {
            const projectData = {
                name: 'New Project',
                sourceLocale: 'en',
                targetLocales: ['fr', 'es']
            };
            const errorResponse = {
                error: {
                    message: 'Project creation failed'
                }
            };

            global.fetch.mockResolvedValueOnce({
                ok: false,
                status: 422,
                json: () => Promise.resolve(errorResponse)
            });

            await expect(createProject(projectData)).rejects.toThrow('Project creation failed');
        });
    });
}); 