Implement structured logging (replace console.log)
Locations: app.js (~20 instances), characters.js, database.js, clientNetwork.js

Replace with pino or winston?

###

13. Upgrade ESLint configuration
File: eslint.config.js

Upgrade ecmaVersion to 2024/2025
Enable rules: no-var, prefer-const, prefer-template, eqeqeq, no-console
Add @stylistic/eslint-plugin for style rules
Add eslint-plugin-import when migrating to ESM
Effort: Medium

###

14. Expand Prettier configuration
File: .prettierrc.json

Change singleQuote: true, printWidth: 120 for better readability
Add endOfLine: "lf" for cross-platform consistency
Effort: Low
15. Fix Prettier formatting across index.js