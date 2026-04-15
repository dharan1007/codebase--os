# Contributing to Codebase OS

First off, thank you for considering contributing to Codebase OS! It's people like you that make Codebase OS such a great tool.

## Code of Conduct

By participating in this project, you are expected to uphold our Code of Conduct.

## How Can I Contribute?

### Reporting Bugs
This section guides you through submitting a bug report for Codebase OS. Following these guidelines helps maintainers and the community understand your report, reproduce the behavior, and find related reports.

- **Check for duplicates**: Before opening a new issue, search the [Issues](https://github.com/dharan1007/codebase--os/issues) to see if the problem has already been reported.
- **Use the template**: Use the "Bug report" template provided when creating a new issue.

### Suggesting Enhancements
This section guides you through submitting an enhancement suggestion for Codebase OS, including completely new features and minor improvements to existing functionality.

- **Check for duplicates**: Like with bug reports, check the issues first.
- **Use the template**: Use the "Feature request" template.

## Development Setup

1. Fork the repository.
2. Install dependencies: `npm install`.
3. Create a branch: `git checkout -b my-new-feature`.
4. Make your changes.
5. Verify changes with a build: `npm run build`.
6. Submit a Pull Request.

## Architecture Guidelines

- **Core**: Keep the core logic in `src/core` atomic and testable.
- **AI**: New providers should be added to `src/core/ai/providers` and registered in `AIProviderFactory.ts`.
- **CLI**: Commands should be modular in `src/cli/commands`.

Thank you for helping us make Codebase OS the best it can be!
