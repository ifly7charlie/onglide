/** @type {import("prettier").Config} */
export default {
  plugins: ["prettier-plugin-embed", "prettier-plugin-sql"],

  // your core options
  printWidth: 225,
  tabWidth: 4,
  semi: true,
  singleQuote: true,
  bracketSpacing: false,
  arrowParens: "always",
  trailingComma: "none",

  // prettier-plugin-embed (CSS + SQL-in-tags etc.)
  // Use at least one of these if you embed CSS:
  embeddedCssTags: ["style"], // or set the tags that contain CSS (adjust as needed)
  embeddedSqlTags: ["sql", "escape"], // your SQL template tag(s)

  // prettier-plugin-sql
  language: "postgresql",
  keywordCase: "upper",
};
