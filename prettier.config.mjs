/** @type {import("prettier").Config} */
export default {
  plugins: ["prettier-plugin-embed"],

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
  embeddedCssTags: ["style"] // or set the tags that contain CSS (adjust as needed)
};
