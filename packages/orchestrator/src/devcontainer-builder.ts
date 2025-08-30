import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { OrchestratorError, ErrorCode } from './types';

export interface DevcontainerBuildResult {
  imageName: string;
  imageTag: string;
  hasDevcontainer: boolean;
  repoHash: string;
}

export interface DevcontainerConfig {
  name?: string;
  image?: string;
  build?: {
    dockerfile?: string;
    context?: string;
  };
  features?: Record<string, any>;
  postCreateCommand?: string | string[];
  postStartCommand?: string | string[];
  customizations?: {
    vscode?: {
      extensions?: string[];
      settings?: Record<string, any>;
    };
  };
}

export class DevcontainerBuilder {
  private tempDir: string;

  constructor(tempDir: string = '/tmp') {
    this.tempDir = tempDir;
  }

  /**
   * Build worker image with full devcontainer support
   */
  async build(repoUrl: string, onProgress?: (message: string) => void): Promise<DevcontainerBuildResult> {
    const progress = (msg: string) => {
      console.log(`[DevcontainerBuilder] ${msg}`);
      onProgress?.(msg);
    };

    progress('🔧 Building your development environment...');

    // Generate unique temp directory
    const repoName = this.extractRepoName(repoUrl);
    const tempRepoDir = path.join(this.tempDir, `peerbot-build-${repoName}-${Date.now()}`);
    
    try {
      // Shallow clone repository
      progress('📋 Applying devcontainer configuration...');
      await this.cloneRepository(repoUrl, tempRepoDir);

      // Generate content hash for caching
      const repoHash = await this.generateRepoHash(tempRepoDir);
      const imageTag = `peerbot-worker-${repoHash}`;

      // Check if devcontainer exists
      const devcontainerPath = path.join(tempRepoDir, '.devcontainer', 'devcontainer.json');
      const hasDevcontainer = await this.fileExists(devcontainerPath);

      if (hasDevcontainer) {
        progress('📦 Installing project dependencies...');
        
        // Parse devcontainer configuration
        const config = await this.parseDevcontainerConfig(devcontainerPath);
        
        // Build using devcontainers CLI
        const imageName = await this.buildWithDevcontainerCli(tempRepoDir, imageTag, config);
        
        // Add peerbot integration to the built image
        await this.addPeerbotIntegration(imageName, progress);

        progress('✅ Environment ready! Starting Claude Code...');

        return {
          imageName,
          imageTag,
          hasDevcontainer: true,
          repoHash
        };
      } else {
        // Use default Bun environment
        progress('📦 Setting up default Bun environment...');
        
        const imageName = await this.buildDefaultImage(tempRepoDir, imageTag);
        
        progress('✅ Environment ready! Starting Claude Code...');

        return {
          imageName,
          imageTag,
          hasDevcontainer: false,
          repoHash
        };
      }
    } finally {
      // Cleanup temp directory
      try {
        await fs.rmdir(tempRepoDir, { recursive: true });
      } catch (error) {
        console.warn('Failed to cleanup temp directory:', error);
      }
    }
  }

  /**
   * Check if image already exists with given tag
   */
  async imageExists(imageTag: string): Promise<boolean> {
    try {
      const result = await this.runCommand('docker', ['images', '-q', imageTag]);
      return result.stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  private async cloneRepository(repoUrl: string, targetDir: string): Promise<void> {
    await this.runCommand('git', [
      'clone',
      '--depth', '1',
      '--single-branch',
      repoUrl,
      targetDir
    ]);
  }

  private async generateRepoHash(repoDir: string): Promise<string> {
    // Create hash based on repo content and devcontainer config
    const gitRevision = await this.runCommand('git', ['rev-parse', 'HEAD'], repoDir);
    const devcontainerPath = path.join(repoDir, '.devcontainer', 'devcontainer.json');
    
    let devcontainerContent = '';
    if (await this.fileExists(devcontainerPath)) {
      devcontainerContent = await fs.readFile(devcontainerPath, 'utf8');
    }

    const hashContent = `${gitRevision.stdout.trim()}:${devcontainerContent}`;
    return crypto.createHash('sha256').update(hashContent).digest('hex').substring(0, 12);
  }

  private async parseDevcontainerConfig(configPath: string): Promise<DevcontainerConfig> {
    try {
      const content = await fs.readFile(configPath, 'utf8');
      // Remove JSON5 comments and parse
      const jsonContent = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      return JSON.parse(jsonContent);
    } catch (error) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_CREATE_FAILED,
        `Failed to parse devcontainer.json: ${error instanceof Error ? error.message : String(error)}`,
        { configPath, error }
      );
    }
  }

  private async buildWithDevcontainerCli(
    repoDir: string,
    imageTag: string,
    config: DevcontainerConfig
  ): Promise<string> {
    const imageName = `peerbot-worker:${imageTag}`;
    
    await this.runCommand('npx', [
      '@devcontainers/cli',
      'build',
      '--workspace-folder', repoDir,
      '--image-name', imageName,
      '--cache-from', 'peerbot-worker:latest'
    ]);

    return imageName;
  }

  private async buildDefaultImage(repoDir: string, imageTag: string): Promise<string> {
    // Create a minimal Dockerfile for default Bun environment
    const dockerfile = `
FROM oven/bun:1.2.9

# Install basic tools
RUN apt-get update && apt-get install -y \\
    git curl bash openssh-client jq sudo ca-certificates \\
    procps htop net-tools iputils-ping && \\
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \\
    apt-get install -y nodejs && \\
    rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN addgroup --gid 1001 claude && \\
    adduser --system --uid 1001 --ingroup claude --home /home/claude claude && \\
    echo 'claude ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

# Copy repository content
COPY . /workspace
WORKDIR /workspace
RUN chown -R claude:claude /workspace

USER claude
`;

    const dockerfilePath = path.join(repoDir, 'Dockerfile.peerbot');
    await fs.writeFile(dockerfilePath, dockerfile);

    const imageName = `peerbot-worker:${imageTag}`;
    await this.runCommand('docker', [
      'build',
      '-f', dockerfilePath,
      '-t', imageName,
      repoDir
    ]);

    // Clean up dockerfile
    await fs.unlink(dockerfilePath);

    return imageName;
  }

  private async addPeerbotIntegration(imageName: string, progress: (msg: string) => void): Promise<void> {
    progress('🔧 Adding Peerbot integration...');
    
    // Get the current directory to copy peerbot packages from
    const peerbotRoot = process.cwd();
    
    // Create a new image layer with peerbot packages
    const dockerfile = `
FROM ${imageName}

# Install Claude Code CLI if not already present
RUN if ! command -v claude >/dev/null 2>&1; then \\
      npm install -g @anthropic-ai/claude-code; \\
    fi

# Copy peerbot packages from host
COPY packages /app/packages
COPY scripts /app/scripts

# Set up MCP configuration for the container user
RUN USER_HOME=\\$(getent passwd \\$(whoami) | cut -d: -f6) && \\
    mkdir -p "\\$USER_HOME/.claude" && \\
    if [ -f "/app/packages/worker/mcp-config.json" ]; then \\
      cp /app/packages/worker/mcp-config.json "\\$USER_HOME/.claude/settings.mcp.json"; \\
    fi

# Install dependencies and build peerbot packages
RUN cd /app && \\
    if [ -f "package.json" ]; then bun install; fi && \\
    cd /app/packages/shared && bun run build && \\
    cd /app/packages/worker && bun run build && \\
    chmod +x /app/packages/worker/dist/mcp/process-manager-server.mjs 2>/dev/null || true

# Set up git configuration  
RUN git config --global user.name "Claude Code Worker" && \\
    git config --global user.email "claude-code-worker@noreply.github.com" && \\
    git config --global init.defaultBranch main && \\
    git config --global pull.rebase false && \\
    git config --global safe.directory '*'

WORKDIR /workspace
`;

    const tempDockerfile = path.join(this.tempDir, `Dockerfile.peerbot-${Date.now()}`);
    await fs.writeFile(tempDockerfile, dockerfile);

    try {
      await this.runCommand('docker', [
        'build',
        '-f', tempDockerfile,
        '-t', imageName,
        peerbotRoot  // Use peerbot root as build context
      ]);
    } finally {
      await fs.unlink(tempDockerfile);
    }
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private extractRepoName(repoUrl: string): string {
    const match = repoUrl.match(/\/([^\/]+?)(?:\.git)?$/);
    return match?.[1] || 'unknown';
  }

  private async runCommand(
    command: string,
    args: string[],
    cwd?: string
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const process = spawn(command, args, { 
        cwd,
        stdio: 'pipe',
        env: { ...process.env }
      });

      let stdout = '';
      let stderr = '';

      process.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      process.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      process.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(`Command failed: ${command} ${args.join(' ')}\nCode: ${code}\nStderr: ${stderr}`));
        }
      });

      process.on('error', (error) => {
        reject(error);
      });
    });
  }
}