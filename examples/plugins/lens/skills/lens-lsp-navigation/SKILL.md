---
name: lens-lsp-navigation
description: Navigate code with IDE features and run proactive LSP diagnostics on files. Use as PRIMARY for code intelligence and type/error checks.
---

# LSP navigation and diagnostics (pi-lens)

Activate the situational tools first: `pi_lens_activate_tools({ tools: ["lsp_navigation"] })`.

| Need                             | Tool call                                                                 |
| -------------------------------- | ------------------------------------------------------------------------- |
| Check files now                  | `lens_diagnostics({ paths: ["src/a.ts", "src/b.ts"] })`                   |
| Errors only                      | `lens_diagnostics({ severity: "error" })`                                 |
| Where is this defined?           | `lsp_navigation({ operation: "definition", path, line, character })`      |
| Find all usages                  | `lsp_navigation({ operation: "references", path, line, character })`      |
| What type is this?               | `lsp_navigation({ operation: "hover", path, line, character })`           |
| Symbols in a file                | `lsp_navigation({ operation: "documentSymbol", path })`                   |
| Find a symbol across the project | `symbol_search({ query, path })`                                          |
| Read one function                | `read_symbol({ path, symbol })`                                           |
| Rename safely                    | `lsp_navigation({ operation: "rename", path, line, character, newName })` |
| Who calls this?                  | `lsp_navigation({ operation: "incomingCalls", path, line, character })`   |

Lines and characters are 1-based. A false positive: `lens_diagnostic_mark({ path, match, disposition: "false-positive" })`.
