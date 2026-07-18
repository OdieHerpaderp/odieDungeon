// Central configuration module
// Export an object with application settings that can be imported throughout the codebase.
// Add environment‑specific values or load from process.env as needed.

const config = {
    // Example: HTTP server port
    PORT: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
    // Example: database connection string
    DB_URI: process.env.DB_URI || 'mongodb://localhost:27017/app',
    // Add more configuration keys here
};

export default config;
