# Codebase OS — Public Release Guide

Congratulations! Your project is now live on GitHub: `https://github.com/dharan1007/codebase--os.git`.

This guide explains how to maintain the project and how to reach even more users by publishing to the global NPM registry.

## 1. Publishing to NPM (Optional)
If you want people to be able to run `npm install -g codebase-os`, follow these steps:

1. **Create an account** at [npmjs.com](https://www.npmjs.com/).
2. **Login** in your terminal:
   ```bash
   npm login
   ```
3. **Check the name**: Ensure the `"name"` in `package.json` is unique. If `codebase-os` is taken, you might need to use a scope like `@dharan1007/codebase-os`.
4. **Publish**:
   ```bash
   npm publish
   ```

## 2. Direct Installation for Users
Even without NPM, people can use your tool immediately by cloning or using `npx`. 

**The standard installation for users is:**
```bash
# Method 1: Global Install (cloned)
git clone https://github.com/dharan1007/codebase--os.git
cd codebase--os
npm install
npm run build
npm link

# Method 2: Global Install (from GitHub directly)
npm install -g https://github.com/dharan1007/codebase--os.git
```

## 3. Maintenance
- **Issues**: Keep an eye on the "Issues" tab on GitHub. I've already added templates to help users provide good bug reports.
- **PRs**: Other developers can now send you "Pull Requests" to improve the code. Review them in the "Pull Requests" tab.
- **Security**: If anyone reports a security bug at `dharan.poduvu@gmail.com`, please address it promptly to keep the community safe.

## 4. Updates
When you make changes locally:
```bash
git add .
git commit -m "Description of change"
git push origin main
```

---

**You are now the maintainer of a world-class AI agent project. Good luck!**
