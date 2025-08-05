#!/usr/bin/env bun

import { describe, it, expect, beforeEach, afterEach, mock, jest } from "bun:test";
import * as k8s from "@kubernetes/client-node";
import { KubernetesJobManager } from "../kubernetes/job-manager";
import type { KubernetesConfig, WorkerJobRequest } from "../types";

// Mock Kubernetes client
jest.mock("@kubernetes/client-node");
const MockedKubeConfig = k8s.KubeConfig as jest.MockedClass<typeof k8s.KubeConfig>;
const MockedBatchV1Api = k8s.BatchV1Api as jest.MockedClass<typeof k8s.BatchV1Api>;
const MockedCoreV1Api = k8s.CoreV1Api as jest.MockedClass<typeof k8s.CoreV1Api>;

describe("KubernetesJobManager", () => {
  let jobManager: KubernetesJobManager;
  let mockK8sApi: jest.Mocked<k8s.BatchV1Api>;
  let mockCoreApi: jest.Mocked<k8s.CoreV1Api>;
  let mockKubeConfig: jest.Mocked<k8s.KubeConfig>;

  const mockConfig: KubernetesConfig = {
    namespace: "test-namespace",
    workerImage: "test/worker:latest",
    cpu: "500m",
    memory: "1Gi",
    timeoutSeconds: 3600,
    kubeconfig: "/path/to/kubeconfig",
  };

  const mockJobRequest: WorkerJobRequest = {
    sessionKey: "test-session-123",
    userId: "U123456",
    username: "testuser",
    channelId: "C123456",
    threadTs: "1234567890.123456",
    repositoryUrl: "https://github.com/test/repo",
    userPrompt: "Help me with this code",
    slackResponseChannel: "C123456",
    slackResponseTs: "1234567890.123456",
    claudeOptions: { model: "claude-3-sonnet" },
    recoveryMode: false,
  };

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Setup mock APIs
    mockK8sApi = {
      createNamespacedJob: jest.fn(),
      readNamespacedJob: jest.fn(),
      deleteNamespacedJob: jest.fn(),
    } as any;

    mockCoreApi = {
      // Core API methods if needed
    } as any;

    mockKubeConfig = {
      loadFromFile: jest.fn(),
      loadFromCluster: jest.fn(),
      loadFromDefault: jest.fn(),
      makeApiClient: jest.fn(),
    } as any;

    // Configure mocks
    MockedKubeConfig.mockImplementation(() => mockKubeConfig);
    mockKubeConfig.makeApiClient.mockImplementation((apiClass) => {
      if (apiClass === k8s.BatchV1Api) return mockK8sApi as any;
      if (apiClass === k8s.CoreV1Api) return mockCoreApi as any;
      return {} as any;
    });

    // Create job manager instance
    jobManager = new KubernetesJobManager(mockConfig);
  });

  afterEach(() => {
    // Clean up any running timers
    (jobManager as any).cleanup?.();
  });

  describe("Initialization", () => {
    it("should initialize with provided kubeconfig", () => {
      expect(mockKubeConfig.loadFromFile).toHaveBeenCalledWith(mockConfig.kubeconfig);
      expect(mockKubeConfig.makeApiClient).toHaveBeenCalledWith(k8s.BatchV1Api);
      expect(mockKubeConfig.makeApiClient).toHaveBeenCalledWith(k8s.CoreV1Api);
    });

    it("should fallback to in-cluster config when no kubeconfig provided", () => {
      const configWithoutKubeconfig = { ...mockConfig, kubeconfig: undefined };
      mockKubeConfig.loadFromCluster.mockImplementation(() => {
        // Simulate successful in-cluster load
      });

      new KubernetesJobManager(configWithoutKubeconfig);

      expect(mockKubeConfig.loadFromCluster).toHaveBeenCalled();
    });

    it("should fallback to default config when in-cluster fails", () => {
      const configWithoutKubeconfig = { ...mockConfig, kubeconfig: undefined };
      mockKubeConfig.loadFromCluster.mockImplementation(() => {
        throw new Error("Not in cluster");
      });

      new KubernetesJobManager(configWithoutKubeconfig);

      expect(mockKubeConfig.loadFromCluster).toHaveBeenCalled();
      expect(mockKubeConfig.loadFromDefault).toHaveBeenCalled();
    });
  });

  describe("Rate Limiting", () => {
    it("should allow jobs within rate limits", async () => {
      mockK8sApi.createNamespacedJob.mockResolvedValue({ body: {} } as any);

      // First job should succeed
      const jobName1 = await jobManager.createWorkerJob(mockJobRequest);
      expect(jobName1).toBeDefined();
      expect(mockK8sApi.createNamespacedJob).toHaveBeenCalledTimes(1);

      // Second job should also succeed
      const request2 = { ...mockJobRequest, sessionKey: "test-session-124" };
      const jobName2 = await jobManager.createWorkerJob(request2);
      expect(jobName2).toBeDefined();
      expect(mockK8sApi.createNamespacedJob).toHaveBeenCalledTimes(2);
    });

    it("should enforce rate limits per user", async () => {
      mockK8sApi.createNamespacedJob.mockResolvedValue({ body: {} } as any);

      // Create 5 jobs (should be at the limit)
      for (let i = 0; i < 5; i++) {
        const request = { ...mockJobRequest, sessionKey: `test-session-${i}` };
        await jobManager.createWorkerJob(request);
      }

      expect(mockK8sApi.createNamespacedJob).toHaveBeenCalledTimes(5);

      // 6th job should be rate limited
      const request6 = { ...mockJobRequest, sessionKey: "test-session-6" };
      await expect(
        jobManager.createWorkerJob(request6)
      ).rejects.toThrow("Rate limit exceeded for user U123456");
    });

    it("should not affect different users", async () => {
      mockK8sApi.createNamespacedJob.mockResolvedValue({ body: {} } as any);

      // Create 5 jobs for first user
      for (let i = 0; i < 5; i++) {
        const request = { ...mockJobRequest, sessionKey: `test-session-${i}` };
        await jobManager.createWorkerJob(request);
      }

      // Different user should still be able to create jobs
      const differentUserRequest = {
        ...mockJobRequest,
        userId: "U999999",
        sessionKey: "different-user-session",
      };

      const jobName = await jobManager.createWorkerJob(differentUserRequest);
      expect(jobName).toBeDefined();
      expect(mockK8sApi.createNamespacedJob).toHaveBeenCalledTimes(6);
    });

    it("should reset rate limits after time window", async () => {
      mockK8sApi.createNamespacedJob.mockResolvedValue({ body: {} } as any);

      // Fill up the rate limit
      for (let i = 0; i < 5; i++) {
        const request = { ...mockJobRequest, sessionKey: `test-session-${i}` };
        await jobManager.createWorkerJob(request);
      }

      // Mock time advancement (15+ minutes)
      const originalNow = Date.now;
      Date.now = jest.fn().mockReturnValue(originalNow() + 16 * 60 * 1000);

      // Should be able to create jobs again
      const request = { ...mockJobRequest, sessionKey: "new-window-session" };
      const jobName = await jobManager.createWorkerJob(request);
      expect(jobName).toBeDefined();

      // Restore Date.now
      Date.now = originalNow;
    });

    it("should clean up expired rate limit entries", (done) => {
      // Access private rate limit map for testing
      const rateLimitMap = (jobManager as any).rateLimitMap;

      // Add some entries
      rateLimitMap.set("user1", { count: 3, windowStart: Date.now() - 20 * 60 * 1000 });
      rateLimitMap.set("user2", { count: 2, windowStart: Date.now() - 10 * 60 * 1000 });
      rateLimitMap.set("user3", { count: 1, windowStart: Date.now() });

      expect(rateLimitMap.size).toBe(3);

      // Wait for cleanup to run (mocked with shorter interval for testing)
      setTimeout(() => {
        // Only recent entry should remain
        expect(rateLimitMap.size).toBeLessThanOrEqual(1);
        done();
      }, 100);
    });
  });

  describe("Job Creation", () => {
    beforeEach(() => {
      mockK8sApi.createNamespacedJob.mockResolvedValue({ body: {} } as any);
    });

    it("should create job with correct manifest", async () => {
      const jobName = await jobManager.createWorkerJob(mockJobRequest);

      expect(mockK8sApi.createNamespacedJob).toHaveBeenCalledWith(
        mockConfig.namespace,
        expect.objectContaining({
          apiVersion: "batch/v1",
          kind: "Job",
          metadata: expect.objectContaining({
            name: expect.stringMatching(/^claude-worker-.*$/),
            namespace: mockConfig.namespace,
            labels: expect.objectContaining({
              app: "claude-worker",
              component: "worker",
            }),
          }),
          spec: expect.objectContaining({
            activeDeadlineSeconds: mockConfig.timeoutSeconds,
            ttlSecondsAfterFinished: 300,
          }),
        })
      );
    });

    it("should generate unique job names", async () => {
      const jobName1 = await jobManager.createWorkerJob(mockJobRequest);
      
      const request2 = { ...mockJobRequest, sessionKey: "different-session" };
      const jobName2 = await jobManager.createWorkerJob(request2);

      expect(jobName1).not.toBe(jobName2);
      expect(jobName1).toMatch(/^claude-worker-.*$/);
      expect(jobName2).toMatch(/^claude-worker-.*$/);
    });

    it("should return existing job name for duplicate session", async () => {
      const jobName1 = await jobManager.createWorkerJob(mockJobRequest);
      const jobName2 = await jobManager.createWorkerJob(mockJobRequest);

      expect(jobName1).toBe(jobName2);
      expect(mockK8sApi.createNamespacedJob).toHaveBeenCalledTimes(1);
    });

    it("should base64 encode user prompt", async () => {
      const request = { ...mockJobRequest, userPrompt: "Hello World!" };
      await jobManager.createWorkerJob(request);

      const createCall = mockK8sApi.createNamespacedJob.mock.calls[0];
      const jobManifest = createCall[1];
      const container = jobManifest.spec.template.spec.containers[0];
      
      const userPromptEnv = container.env.find((env: any) => env.name === "USER_PROMPT");
      expect(userPromptEnv.value).toBe(Buffer.from("Hello World!").toString("base64"));
    });

    it("should include all required environment variables", async () => {
      await jobManager.createWorkerJob(mockJobRequest);

      const createCall = mockK8sApi.createNamespacedJob.mock.calls[0];
      const jobManifest = createCall[1];
      const container = jobManifest.spec.template.spec.containers[0];
      
      const envNames = container.env.map((env: any) => env.name);
      const requiredEnvs = [
        "SESSION_KEY",
        "USER_ID", 
        "USERNAME",
        "CHANNEL_ID",
        "REPOSITORY_URL",
        "USER_PROMPT",
        "SLACK_BOT_TOKEN",
        "GITHUB_TOKEN",
      ];

      for (const envName of requiredEnvs) {
        expect(envNames).toContain(envName);
      }
    });

    it("should use secrets for sensitive environment variables", async () => {
      await jobManager.createWorkerJob(mockJobRequest);

      const createCall = mockK8sApi.createNamespacedJob.mock.calls[0];
      const jobManifest = createCall[1];
      const container = jobManifest.spec.template.spec.containers[0];
      
      const slackTokenEnv = container.env.find((env: any) => env.name === "SLACK_BOT_TOKEN");
      expect(slackTokenEnv.valueFrom.secretKeyRef).toEqual({
        name: "peerbot-secrets",
        key: "slack-bot-token",
      });

      const githubTokenEnv = container.env.find((env: any) => env.name === "GITHUB_TOKEN");
      expect(githubTokenEnv.valueFrom.secretKeyRef).toEqual({
        name: "peerbot-secrets",
        key: "github-token",
      });
    });

    it("should handle job creation errors", async () => {
      mockK8sApi.createNamespacedJob.mockRejectedValue(new Error("Kubernetes API error"));

      await expect(
        jobManager.createWorkerJob(mockJobRequest)
      ).rejects.toThrow("Failed to create job for session test-session-123");
    });
  });

  describe("Job Monitoring", () => {
    beforeEach(() => {
      mockK8sApi.createNamespacedJob.mockResolvedValue({ body: {} } as any);
    });

    it("should monitor job status", async () => {
      const jobName = await jobManager.createWorkerJob(mockJobRequest);

      // Mock job status responses
      mockK8sApi.readNamespacedJob
        .mockResolvedValueOnce({
          body: { status: { active: 1 } }
        } as any)
        .mockResolvedValueOnce({
          body: { status: { succeeded: 1 } }
        } as any);

      // Wait for monitoring to check status
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockK8sApi.readNamespacedJob).toHaveBeenCalledWith(
        jobName,
        mockConfig.namespace
      );
    });

    it("should clean up completed jobs from tracking", async () => {
      const jobName = await jobManager.createWorkerJob(mockJobRequest);
      
      mockK8sApi.readNamespacedJob.mockResolvedValue({
        body: { status: { succeeded: 1 } }
      } as any);

      // Wait for monitoring to process completion
      await new Promise(resolve => setTimeout(resolve, 100));

      const activeJobs = await jobManager.listActiveJobs();
      expect(activeJobs.find(job => job.name === jobName)).toBeUndefined();
    });

    it("should handle failed jobs", async () => {
      const jobName = await jobManager.createWorkerJob(mockJobRequest);
      
      mockK8sApi.readNamespacedJob.mockResolvedValue({
        body: { status: { failed: 1 } }
      } as any);

      // Wait for monitoring to process failure
      await new Promise(resolve => setTimeout(resolve, 100));

      const activeJobs = await jobManager.listActiveJobs();
      expect(activeJobs.find(job => job.name === jobName)).toBeUndefined();
    });
  });

  describe("Job Management", () => {
    it("should delete jobs", async () => {
      mockK8sApi.deleteNamespacedJob.mockResolvedValue({} as any);

      await jobManager.deleteJob("test-job");

      expect(mockK8sApi.deleteNamespacedJob).toHaveBeenCalledWith(
        "test-job",
        mockConfig.namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        "Background"
      );
    });

    it("should handle job deletion errors", async () => {
      mockK8sApi.deleteNamespacedJob.mockRejectedValue(new Error("Delete failed"));

      // Should not throw - errors are logged
      await expect(jobManager.deleteJob("test-job")).resolves.toBeUndefined();
    });

    it("should get job status", async () => {
      mockK8sApi.readNamespacedJob.mockResolvedValue({
        body: { status: { succeeded: 1 } }
      } as any);

      const status = await jobManager.getJobStatus("test-job");
      expect(status).toBe("succeeded");
    });

    it("should handle different job statuses", async () => {
      const statusTests = [
        { mockStatus: { succeeded: 1 }, expected: "succeeded" },
        { mockStatus: { failed: 1 }, expected: "failed" },
        { mockStatus: { active: 1 }, expected: "running" },
        { mockStatus: {}, expected: "pending" },
      ];

      for (const test of statusTests) {
        mockK8sApi.readNamespacedJob.mockResolvedValueOnce({
          body: { status: test.mockStatus }
        } as any);

        const status = await jobManager.getJobStatus("test-job");
        expect(status).toBe(test.expected);
      }
    });

    it("should return unknown status on errors", async () => {
      mockK8sApi.readNamespacedJob.mockRejectedValue(new Error("API error"));

      const status = await jobManager.getJobStatus("test-job");
      expect(status).toBe("unknown");
    });
  });

  describe("Active Job Tracking", () => {
    beforeEach(() => {
      mockK8sApi.createNamespacedJob.mockResolvedValue({ body: {} } as any);
      mockK8sApi.readNamespacedJob.mockResolvedValue({
        body: { status: { active: 1 } }
      } as any);
    });

    it("should list active jobs", async () => {
      const jobName1 = await jobManager.createWorkerJob(mockJobRequest);
      const request2 = { ...mockJobRequest, sessionKey: "session-2" };
      const jobName2 = await jobManager.createWorkerJob(request2);

      const activeJobs = await jobManager.listActiveJobs();

      expect(activeJobs).toHaveLength(2);
      expect(activeJobs.find(job => job.name === jobName1)).toBeDefined();
      expect(activeJobs.find(job => job.name === jobName2)).toBeDefined();
    });

    it("should return correct active job count", async () => {
      expect(jobManager.getActiveJobCount()).toBe(0);

      await jobManager.createWorkerJob(mockJobRequest);
      expect(jobManager.getActiveJobCount()).toBe(1);

      const request2 = { ...mockJobRequest, sessionKey: "session-2" };
      await jobManager.createWorkerJob(request2);
      expect(jobManager.getActiveJobCount()).toBe(2);
    });

    it("should cleanup all jobs", async () => {
      mockK8sApi.deleteNamespacedJob.mockResolvedValue({} as any);

      await jobManager.createWorkerJob(mockJobRequest);
      const request2 = { ...mockJobRequest, sessionKey: "session-2" };
      await jobManager.createWorkerJob(request2);

      expect(jobManager.getActiveJobCount()).toBe(2);

      await jobManager.cleanup();

      expect(jobManager.getActiveJobCount()).toBe(0);
      expect(mockK8sApi.deleteNamespacedJob).toHaveBeenCalledTimes(2);
    });
  });
});