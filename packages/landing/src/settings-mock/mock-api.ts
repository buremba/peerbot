// Stubs for every export from @settings/api — no real HTTP calls.
// Vite alias replaces "@settings/api" imports with this file.

export async function switchAgent() {
  /* noop */
}
export async function createAgent() {
  /* noop */
}
export async function updateAgentIdentity() {
  /* noop */
}
export async function deleteAgent() {
  /* noop */
}

export async function saveSettings() {
  /* noop */
}

export async function checkProviders(): Promise<
  Record<
    string,
    {
      connected: boolean;
      userConnected: boolean;
      systemConnected: boolean;
      activeAuthType?: string;
      authMethods?: string[];
    }
  >
> {
  return {
    anthropic: {
      connected: true,
      userConnected: true,
      systemConnected: false,
      activeAuthType: "api-key",
      authMethods: ["api-key"],
    },
    openai: {
      connected: true,
      userConnected: true,
      systemConnected: false,
      activeAuthType: "api-key",
      authMethods: ["api-key"],
    },
  };
}

export async function installProvider() {
  /* noop */
}
export async function uninstallProvider() {
  /* noop */
}
export async function reorderProviders() {
  /* noop */
}

export async function submitOAuthCode() {
  /* noop */
}
export async function submitApiKey() {
  /* noop */
}
export async function startDeviceCode() {
  return {
    userCode: "DEMO-CODE",
    verificationUrl: "#",
    deviceAuthId: "demo",
    interval: 5,
  };
}
export async function pollDeviceCode() {
  return { status: "completed" };
}
export async function disconnectProvider() {
  /* noop */
}

export async function fetchIntegrationsRegistry() {
  return { skills: [], mcps: [] };
}
export async function fetchSkillContent() {
  return { repo: "", name: "", description: "", content: "", fetchedAt: 0 };
}
export async function saveSkills() {
  /* noop */
}
export async function saveMcpServers() {
  /* noop */
}

export async function fetchSchedules() {
  return [];
}
export async function cancelSchedule() {
  /* noop */
}

export async function fetchGrants() {
  return [];
}
export async function addGrant() {
  /* noop */
}
export async function removeGrant() {
  /* noop */
}

export async function searchNixPackages() {
  return [];
}
