import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client, ConnectConfig } from 'ssh2';
import { SshTunnelOptions } from '../types';

export interface SshTunnel {
  /** Loopback port to connect the database driver to. */
  localPort: number;
  dispose(): Promise<void>;
}

/**
 * Open an SSH connection and a loopback TCP server that forwards every
 * accepted socket to `targetHost:targetPort` through it. The database driver
 * then connects to `127.0.0.1:localPort` as if the server were local.
 *
 * `secret` is the SSH password (authMethod 'password') or the private-key
 * passphrase (authMethod 'key', optional for unencrypted keys).
 */
export async function openSshTunnel(
  options: SshTunnelOptions,
  targetHost: string,
  targetPort: number,
  secret: string | undefined,
): Promise<SshTunnel> {
  const client = new Client();

  await new Promise<void>((resolve, reject) => {
    client.once('ready', resolve);
    client.once('error', (error) => reject(new Error(`SSH connection failed: ${error.message}`)));
    client.connect(buildConnectConfig(options, secret));
  });

  const server = net.createServer((socket) => {
    client.forwardOut(
      socket.remoteAddress ?? '127.0.0.1',
      socket.remotePort ?? 0,
      targetHost,
      targetPort,
      (error, stream) => {
        if (error) {
          socket.destroy(error);
          return;
        }
        socket.pipe(stream).pipe(socket);
        stream.on('error', () => socket.destroy());
        socket.on('error', () => stream.destroy());
      },
    );
  });

  const localPort = await new Promise<number>((resolve, reject) => {
    server.once('error', (error) => reject(error));
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        resolve(address.port);
      } else {
        reject(new Error('Failed to open a local port for the SSH tunnel.'));
      }
    });
  });

  // If the SSH session drops later, stop accepting sockets so the driver sees
  // connection errors instead of hangs.
  client.on('error', () => server.close());
  client.on('close', () => server.close());

  return {
    localPort,
    dispose: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          client.end();
          resolve();
        });
      }),
  };
}

function buildConnectConfig(options: SshTunnelOptions, secret: string | undefined): ConnectConfig {
  const config: ConnectConfig = {
    host: options.host,
    port: options.port,
    username: options.user,
    readyTimeout: 10000,
    keepaliveInterval: 15000,
  };

  switch (options.authMethod) {
    case 'password':
      config.password = secret ?? '';
      break;

    case 'key': {
      if (!options.keyPath) {
        throw new Error('SSH key authentication requires a private key path.');
      }
      config.privateKey = fs.readFileSync(expandHome(options.keyPath));
      if (secret) {
        config.passphrase = secret;
      }
      break;
    }

    case 'agent':
      config.agent = process.env.SSH_AUTH_SOCK;
      if (!config.agent) {
        throw new Error('SSH agent authentication requires SSH_AUTH_SOCK to be set.');
      }
      break;
  }

  return config;
}

function expandHome(filePath: string): string {
  if (filePath === '~' || filePath.startsWith('~/')) {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}
