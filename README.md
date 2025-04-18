# LocalHero.ai CLI 🌍✨

> Automatic translations for teams that ship

LocalHero.ai is an AI-powered I18n translation service that seamlessly integrates with your development workflow. It automatically detects and translates I18n keys with missing translations, then saving any new translations directly to your repository. [Learn more at localhero.ai](https://localhero.ai/)

## Features 🚀

- 🤖 AI-powered translations that preserve your brand voice
- 🔌 Seamless integration with Rails, React and other frameworks coming soon
- 🚀 Automated workflow with GitHub Actions support
- 📦 Works with YAML and JSON translation files

## Getting Started 🏁

1. Sign up for a free trial at [localhero.ai](https://localhero.ai/).
2. Get your API key from [localhero.ai/api-keys](https://localhero.ai/api-keys)
3. Run the init command in your project to setup the configuration:
   ```bash
   npx @localheroai/cli init
   ```

## Commands 👏

### Initialize a Project

```bash
npx @localheroai/cli init
```

The init command helps you set up your project with LocalHero.ai. It will:
- Setup your API key if it hasn't been done already
- Detect your project type (Rails, React, or generic)
- Link to an existing LocalHero.ai project
- Configure translation paths and file patterns
- Set up GitHub Actions (optional)
- Import existing translations (optional)

This creates a `localhero.json` configuration file in your project root that stores your project settings:
- Project identifier
- Source and target languages for translation
- Translation file paths and patterns
- Ignore patterns for files to exclude

The configuration file is used by the tool to interact with your translations and the API.

### Login

```bash
npx @localheroai/cli login
```

Authenticate with the API using your API key.  This will save your API key to `.localhero_key` and add the file to .gitignore if needed.

Use this when:
- Setting up a new development environment
- Updating your API key
- Verifying your authentication status

### Translate

```bash
npx @localheroai/cli translate
```

Translating your missing keys:
- Automatically detects missing translations and sends them to the Localhero.ai translation API for translation
- Updates translation files with any new or update translations
- It's run manually or by GitHub Actions. When run as a GitHub action any new translations are automatically committed to git.

### Pull / push

```bash
npx @localheroai/cli pull
```

Pull the latest translation updates from LocalHero.ai to your local files. This command will download any new or modified translations from the service to your local files.

```bash
npx @localheroai/cli push
```

Push updates from your local translation files to LocalHero.ai. This command will upload any new or modified translations from your local files to the service.

## Environment Variables ⚙️

Typically you don't need to set these. The cli will use `LOCALHERO_API_KEY` if it's set, otherwise it will check the file `.localhero_key` for a API key.

Configure the CLI behavior with these environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `LOCALHERO_API_KEY` | Your LocalHero API key (get it at [localhero.ai/api-keys](https://localhero.ai/api-keys)) | Required |
| `LOCALHERO_API_HOST` | API host for LocalHero (you typically don't need to change this) | https://api.localhero.ai |

## GitHub Actions Integration 🤖

LocalHero.ai automatically translate your I18n files when you push changes. During the `init` command, you'll be prompted to set up GitHub Actions.

1. Add your API key to your repository secrets:
   - Go to Settings > Secrets and variables > Actions
   - Create a new secret named `LOCALHERO_API_KEY`
   - Add your API key as the value

2. The workflow will:
   - Run on push to pull requests
   - Check for missing translations and add new/updated translations to the repo.

## Support 💬

- Documentation: [localhero.ai/docs](https://localhero.ai/docs)
- Email: hi@localhero.ai

## License 📄

MIT License - see LICENSE file for details
