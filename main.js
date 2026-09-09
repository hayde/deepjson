// main.js - Server Entry Point
const DeepJSONServer = require('./server');

async function startServer() {
  try {
    const server = new DeepJSONServer();
    await server.initialize();
    
    console.log(`Server started on port ${server.config.port}`);

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      console.log('\nShutting down server...');
      server.shutdown().then(() => process.exit(0));
    });
    
  } catch (error) {
    console.error('Failed to start server:');
    console.error(error);
    process.exit(1);
  }
}

// Start the application
startServer();