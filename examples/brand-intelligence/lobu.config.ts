import { connectorFromFile, defineConfig } from "@lobu/cli/config";
import type CapterraConnector from "./capterra.connector.ts";
import type G2Connector from "./g2.connector.ts";
import type GmapsConnector from "./gmaps.connector.ts";
import type GlassdoorConnector from "./glassdoor.connector.ts";
import type GooglePlayConnector from "./google_play.connector.ts";
import type IosAppstoreConnector from "./ios_appstore.connector.ts";
import type TrustpilotConnector from "./trustpilot.connector.ts";
import type WebsiteConnector from "./website.connector.ts";

export default defineConfig({
  agents: [],
  org: "brand-intelligence",
  orgName: "Brand Intelligence",
  orgDescription:
    "Example connectors for review sites and public web pages — not official Lobu integrations",
  connectors: [
    connectorFromFile<typeof TrustpilotConnector>("./trustpilot.connector.ts"),
    connectorFromFile<typeof G2Connector>("./g2.connector.ts"),
    connectorFromFile<typeof CapterraConnector>("./capterra.connector.ts"),
    connectorFromFile<typeof GlassdoorConnector>("./glassdoor.connector.ts"),
    connectorFromFile<typeof WebsiteConnector>("./website.connector.ts"),
    connectorFromFile<typeof GooglePlayConnector>("./google_play.connector.ts"),
    connectorFromFile<typeof IosAppstoreConnector>(
      "./ios_appstore.connector.ts"
    ),
    connectorFromFile<typeof GmapsConnector>("./gmaps.connector.ts"),
  ],
});
