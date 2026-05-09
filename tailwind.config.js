/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html"],
  theme: {
    extend: {
      colors: {
        bnu: {
          green: "#005b3a",
          light: "#e6f0ec",
          gold: "#dfa130",
          danger: "#e35252",
        },
      },
    },
  },
  plugins: [require("@tailwindcss/line-clamp")],
};
