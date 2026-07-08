import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  type ConnectorDefinition,
  ConnectorRuntime,
  type EventAttributionRule,
  type EventEnvelope,
  type SyncContext,
  type SyncResult,
} from "@lobu/connector-sdk";
import {
  LINKEDIN_EMAIL_NAMESPACE,
  LINKEDIN_IDENTITY,
  normalizeLinkedInSlug,
} from "./linkedin-identity.ts";
import {
  assertDirectory,
  batchSize,
  type LocalTakeoutConfig,
  maxEventCursor,
  parseCsv,
  stableId,
  stripHtml,
  takeBatch,
} from "./takeout-utils.ts";

/**
 * Link a `connection` event to the connected person via their canonical
 * `linkedin_slug` (extracted from the profile URL) plus their `email`. Neither
 * is `primary` — they match equal-weight cross-channel until a stable primary
 * id arrives from the live connector. The full URL is kept as a display trait,
 * not an identity (case/URL noise would fork the entity). Connections ARE the
 * user's network, so we mint (`autoCreate`) a person per row.
 */
const LINKEDIN_CONNECTION_ATTRIBUTIONS: EventAttributionRule[] = [
  {
    role: "about",
    autoCreate: true,
    target: {
      entityType: "person",
      titlePath: "author_name",
      identities: [
        {
          namespace: LINKEDIN_IDENTITY.SLUG,
          eventPath: "metadata.linkedin_slug",
        },
        { namespace: LINKEDIN_EMAIL_NAMESPACE, eventPath: "metadata.email" },
      ],
    },
    traits: {
      linkedin_url: {
        eventPath: "metadata.linkedin_url",
        behavior: "prefer_non_empty",
      },
      company: { eventPath: "metadata.company", behavior: "prefer_non_empty" },
      position: {
        eventPath: "metadata.position",
        behavior: "prefer_non_empty",
      },
    },
  },
];

/**
 * Link a `message` event to its sender (the counterparty) via the
 * `linkedin_slug` extracted from their profile URL, plus display name. Real
 * counterparties, so mint on no match.
 */
const LINKEDIN_MESSAGE_ATTRIBUTIONS: EventAttributionRule[] = [
  {
    role: "authored_by",
    autoCreate: true,
    target: {
      entityType: "person",
      titlePath: "metadata.from",
      identities: [
        {
          namespace: LINKEDIN_IDENTITY.SLUG,
          eventPath: "metadata.sender_linkedin_slug",
        },
      ],
    },
    traits: {
      linkedin_url: {
        eventPath: "metadata.sender_profile_url",
        behavior: "prefer_non_empty",
      },
      last_linkedin_message_at: {
        eventPath: "occurred_at",
        behavior: "overwrite",
      },
    },
  },
];

interface LinkedInTakeoutCheckpoint {
  last_messages_timestamp?: string;
  last_connections_timestamp?: string;
  last_invitations_timestamp?: string;
  last_jobs_timestamp?: string;
  last_profile_timestamp?: string;
  last_companies_timestamp?: string;
  last_learning_timestamp?: string;
  last_events_timestamp?: string;
  last_endorsements_timestamp?: string;
  last_media_timestamp?: string;
}

export default class LinkedInTakeoutConnector extends ConnectorRuntime<
  LinkedInTakeoutCheckpoint,
  LocalTakeoutConfig
> {
  readonly definition: ConnectorDefinition = {
    key: "linkedin.takeout",
    name: "LinkedIn Takeout",
    version: "1.0.0",
    description: "Ingests local LinkedIn Data Export CSV files.",
    authSchema: { methods: [{ type: "none" }] },
    feeds: {
      messages: {
        key: "messages",
        name: "Messages",
        configSchema: localTakeoutSchema(
          "Path to the LinkedIn Data Export folder."
        ),
        eventKinds: {
          message: {
            description: "A LinkedIn direct message",
            attributions: LINKEDIN_MESSAGE_ATTRIBUTIONS,
          },
        },
      },
      connections: {
        key: "connections",
        name: "Connections",
        configSchema: localTakeoutSchema(
          "Path to the LinkedIn Data Export folder."
        ),
        eventKinds: {
          connection: {
            description: "A first-degree LinkedIn connection",
            attributions: LINKEDIN_CONNECTION_ATTRIBUTIONS,
          },
        },
      },
      invitations: {
        key: "invitations",
        name: "Invitations",
        configSchema: localTakeoutSchema(
          "Path to the LinkedIn Data Export folder."
        ),
      },
      jobs: {
        key: "jobs",
        name: "Job Postings",
        configSchema: localTakeoutSchema(
          "Path to the LinkedIn Data Export folder."
        ),
      },
      profile: {
        key: "profile",
        name: "Profile",
        configSchema: localTakeoutSchema(
          "Path to the LinkedIn Data Export folder."
        ),
      },
      companies: {
        key: "companies",
        name: "Company Follows",
        configSchema: localTakeoutSchema(
          "Path to the LinkedIn Data Export folder."
        ),
      },
      learning: {
        key: "learning",
        name: "Learning",
        configSchema: localTakeoutSchema(
          "Path to the LinkedIn Data Export folder."
        ),
      },
      events: {
        key: "events",
        name: "Events",
        configSchema: localTakeoutSchema(
          "Path to the LinkedIn Data Export folder."
        ),
      },
      endorsements: {
        key: "endorsements",
        name: "Endorsements and Recommendations",
        configSchema: localTakeoutSchema(
          "Path to the LinkedIn Data Export folder."
        ),
      },
      media: {
        key: "media",
        name: "Rich Media",
        configSchema: localTakeoutSchema(
          "Path to the LinkedIn Data Export folder."
        ),
      },
    },
  };

  async sync(
    ctx: SyncContext<LinkedInTakeoutCheckpoint, LocalTakeoutConfig>
  ): Promise<SyncResult<LinkedInTakeoutCheckpoint>> {
    const takeoutDir = assertDirectory(ctx.config, "LinkedIn");
    const max = batchSize(ctx.config);

    if (ctx.feedKey === "messages") {
      return this.result(
        ctx,
        "last_messages_timestamp",
        this.readMessages(takeoutDir),
        max
      );
    }
    if (ctx.feedKey === "connections") {
      return this.result(
        ctx,
        "last_connections_timestamp",
        this.readConnections(takeoutDir),
        max
      );
    }
    if (ctx.feedKey === "invitations") {
      return this.result(
        ctx,
        "last_invitations_timestamp",
        this.readInvitations(takeoutDir),
        max
      );
    }
    if (ctx.feedKey === "jobs") {
      return this.result(
        ctx,
        "last_jobs_timestamp",
        this.readJobs(takeoutDir),
        max
      );
    }
    if (ctx.feedKey === "profile") {
      return this.result(
        ctx,
        "last_profile_timestamp",
        this.readProfile(takeoutDir),
        max
      );
    }
    if (ctx.feedKey === "companies") {
      return this.result(
        ctx,
        "last_companies_timestamp",
        this.readCompanyFollows(takeoutDir),
        max
      );
    }
    if (ctx.feedKey === "learning") {
      return this.result(
        ctx,
        "last_learning_timestamp",
        this.readLearning(takeoutDir),
        max
      );
    }
    if (ctx.feedKey === "events") {
      return this.result(
        ctx,
        "last_events_timestamp",
        this.readEvents(takeoutDir),
        max
      );
    }
    if (ctx.feedKey === "endorsements") {
      return this.result(
        ctx,
        "last_endorsements_timestamp",
        this.readEndorsements(takeoutDir),
        max
      );
    }
    if (ctx.feedKey === "media") {
      return this.result(
        ctx,
        "last_media_timestamp",
        this.readRichMedia(takeoutDir),
        max
      );
    }

    throw new Error(`Unknown LinkedIn Takeout feed: ${ctx.feedKey}`);
  }

  private result(
    ctx: SyncContext<LinkedInTakeoutCheckpoint, LocalTakeoutConfig>,
    key: keyof LinkedInTakeoutCheckpoint,
    allEvents: EventEnvelope[],
    max: number
  ): SyncResult<LinkedInTakeoutCheckpoint> {
    const events = takeBatch(allEvents, ctx.checkpoint?.[key], max);
    return {
      events,
      checkpoint: {
        ...ctx.checkpoint,
        [key]: maxEventCursor(events, ctx.checkpoint?.[key]),
      },
    };
  }

  private readMessages(takeoutDir: string): EventEnvelope[] {
    return readCsv(takeoutDir, "messages.csv").flatMap((row) => {
      const occurredAt = parseLinkedInDate(row.DATE);
      const content = row.CONTENT?.trim();
      if (!occurredAt || !content) return [];
      return [
        {
          origin_id: stableId("li_message", [
            row["CONVERSATION ID"],
            row.DATE,
            row.FROM,
            row.TO,
            content,
          ]),
          origin_type: "message",
          occurred_at: occurredAt,
          payload_text: content,
          author_name: row.FROM,
          source_url: row["SENDER PROFILE URL"],
          title: row["CONVERSATION TITLE"] || row.SUBJECT,
          metadata: {
            platform: "linkedin",
            conversation_id: row["CONVERSATION ID"],
            conversation_title: row["CONVERSATION TITLE"],
            from: row.FROM,
            sender_profile_url: row["SENDER PROFILE URL"],
            sender_linkedin_slug:
              normalizeLinkedInSlug(row["SENDER PROFILE URL"]) ?? undefined,
            to: row.TO,
            recipient_profile_urls: row["RECIPIENT PROFILE URLS"],
            subject: row.SUBJECT,
            folder: row.FOLDER,
            attachments: row.ATTACHMENTS,
          },
        },
      ];
    });
  }

  private readConnections(takeoutDir: string): EventEnvelope[] {
    return readCsv(takeoutDir, "Connections.csv").flatMap((row) => {
      const fullName = [row["First Name"], row["Last Name"]]
        .filter(Boolean)
        .join(" ")
        .trim();
      const occurredAt = parseLinkedInDate(row["Connected On"]);
      if (!fullName || !occurredAt) return [];
      return [
        {
          origin_id: stableId("li_connection", [
            row.URL,
            fullName,
            row["Connected On"],
          ]),
          origin_type: "connection",
          occurred_at: occurredAt,
          payload_text: `Connected with ${fullName}${row.Company ? ` at ${row.Company}` : ""}`,
          author_name: fullName,
          source_url: row.URL,
          metadata: {
            platform: "linkedin",
            first_name: row["First Name"],
            last_name: row["Last Name"],
            email: row["Email Address"],
            company: row.Company,
            position: row.Position,
            linkedin_url: row.URL,
            // Pre-canonicalized identity key. The server never loads example
            // connectors' normalizer modules, so we emit the already-lowercased
            // /in/<slug> here; the engine stores it verbatim (trim fallback) and
            // case-variant URLs from any source collapse to one entity.
            linkedin_slug: normalizeLinkedInSlug(row.URL) ?? undefined,
          },
        },
      ];
    });
  }

  private readInvitations(takeoutDir: string): EventEnvelope[] {
    return readCsv(takeoutDir, "Invitations.csv").flatMap((row) => {
      const occurredAt = parseLinkedInDate(
        row["Sent At"] || row["Received At"] || row.Date
      );
      const name =
        row.To ||
        row.From ||
        row.Name ||
        row["Invitee Name"] ||
        row["Inviter Name"];
      if (!occurredAt || !name) return [];
      return [
        {
          origin_id: stableId("li_invitation", [
            name,
            row["Sent At"],
            row["Received At"],
            row.Message,
          ]),
          origin_type: "invitation",
          occurred_at: occurredAt,
          payload_text: row.Message || `LinkedIn invitation: ${name}`,
          author_name: row.From,
          metadata: {
            platform: "linkedin",
            from: row.From,
            to: row.To,
            name,
            sent_at: row["Sent At"],
            received_at: row["Received At"],
            message: row.Message,
            invitation_type: row["Invitation Type"],
          },
        },
      ];
    });
  }

  private readJobs(takeoutDir: string): EventEnvelope[] {
    return readCsv(
      takeoutDir,
      path.join("Jobs", "Online Job Postings.csv")
    ).flatMap((row) => {
      const occurredAt =
        parseLinkedInDate(
          row["Create Date"] || row["List Date"] || row["Close Date"]
        ) ?? snapshotDate();
      const title = row.Title || row["Job Title"] || row.Position;
      const company = row["Company Name"] || row.Company;
      const sourceUrl = row["Company Apply Url"] || row.URL;
      if (!title) return [];
      return [
        {
          origin_id: stableId("li_job", [
            title,
            company,
            row["Create Date"],
            sourceUrl,
          ]),
          origin_type: "job_posting",
          occurred_at: occurredAt,
          payload_text: [
            title,
            company,
            row["Location Description"],
            stripHtml(row["Job Description"] ?? ""),
          ]
            .filter(Boolean)
            .join("\n"),
          title,
          source_url: sourceUrl,
          metadata: {
            platform: "linkedin",
            title,
            company,
            employment_status: row["Employment Status"],
            location: row["Location Description"],
            job_functions: row["Job Functions"],
            industries: row["Company Industries"],
            seniority: row["Seniority Level"],
            required_skills: row["Required Skills"],
            education_levels: row["Education Levels"],
            onsite_apply: row["Onsite Apply"],
            contact_email: row["Contact Email"],
            base_salary: row["Base Salary"],
            additional_compensation: row["Additional Compensation"],
            job_state: row["Job State"],
            create_date: row["Create Date"],
            list_date: row["List Date"],
            close_date: row["Close Date"],
            expiration_date: row["Expiration Date"],
            url: sourceUrl,
          },
        },
      ];
    });
  }

  private readProfile(takeoutDir: string): EventEnvelope[] {
    const profile = readCsv(takeoutDir, "Profile.csv")[0];
    const profileEvents: EventEnvelope[] = profile
      ? [
          {
            origin_id: stableId("li_profile", [
              profile["First Name"],
              profile["Last Name"],
              profile.Headline,
              profile["Geo Location"],
            ]),
            origin_type: "profile",
            occurred_at: snapshotDate(),
            payload_text: [
              [profile["First Name"], profile["Last Name"]]
                .filter(Boolean)
                .join(" "),
              profile.Headline,
              profile.Summary,
              profile.Industry,
              profile["Geo Location"],
            ]
              .filter(Boolean)
              .join("\n"),
            title: profile.Headline,
            metadata: {
              platform: "linkedin",
              first_name: profile["First Name"],
              last_name: profile["Last Name"],
              headline: profile.Headline,
              summary: profile.Summary,
              industry: profile.Industry,
              location: profile["Geo Location"],
              websites: profile.Websites,
              twitter_handles: profile["Twitter Handles"],
            },
          },
        ]
      : [];

    const positions = readCsv(takeoutDir, "Positions.csv").flatMap((row) => {
      const title = row.Title;
      const company = row["Company Name"];
      if (!title && !company) return [];
      return [
        {
          origin_id: stableId("li_position", [
            company,
            title,
            row["Started On"],
            row["Finished On"],
          ]),
          origin_type: "position",
          occurred_at: parseLinkedInDate(row["Started On"]) ?? snapshotDate(),
          payload_text: [title, company, row.Location, row.Description]
            .filter(Boolean)
            .join("\n"),
          title: [title, company].filter(Boolean).join(" at "),
          metadata: {
            platform: "linkedin",
            company,
            title,
            description: row.Description,
            location: row.Location,
            started_on: row["Started On"],
            finished_on: row["Finished On"],
          },
        },
      ];
    });

    const education = readCsv(takeoutDir, "Education.csv").flatMap((row) => {
      const school = row["School Name"];
      if (!school) return [];
      return [
        {
          origin_id: stableId("li_education", [
            school,
            row["Degree Name"],
            row["Start Date"],
            row["End Date"],
          ]),
          origin_type: "education",
          occurred_at: parseLinkedInDate(row["Start Date"]) ?? snapshotDate(),
          payload_text: [school, row["Degree Name"], row.Activities, row.Notes]
            .filter(Boolean)
            .join("\n"),
          title: [row["Degree Name"], school].filter(Boolean).join(" - "),
          metadata: {
            platform: "linkedin",
            school,
            degree: row["Degree Name"],
            start_date: row["Start Date"],
            end_date: row["End Date"],
            activities: row.Activities,
            notes: row.Notes,
          },
        },
      ];
    });

    const skills = readCsv(takeoutDir, "Skills.csv").flatMap((row) => {
      if (!row.Name) return [];
      return [
        {
          origin_id: stableId("li_skill", [row.Name]),
          origin_type: "skill",
          occurred_at: snapshotDate(),
          payload_text: row.Name,
          title: row.Name,
          metadata: { platform: "linkedin", skill: row.Name },
        },
      ];
    });

    return [...profileEvents, ...positions, ...education, ...skills];
  }

  private readCompanyFollows(takeoutDir: string): EventEnvelope[] {
    return readCsv(takeoutDir, "Company Follows.csv").flatMap((row) => {
      const organization = row.Organization;
      const occurredAt = parseLinkedInDate(row["Followed On"]);
      if (!organization || !occurredAt) return [];
      return [
        {
          origin_id: stableId("li_company_follow", [
            organization,
            row["Followed On"],
          ]),
          origin_type: "company_follow",
          occurred_at: occurredAt,
          payload_text: `Followed ${organization}`,
          title: organization,
          metadata: {
            platform: "linkedin",
            organization,
            followed_on: row["Followed On"],
          },
        },
      ];
    });
  }

  private readLearning(takeoutDir: string): EventEnvelope[] {
    return readCsv(takeoutDir, "Learning.csv").flatMap((row) => {
      const title = row["Content Title"];
      if (!title) return [];
      const occurredAt =
        parseLinkedInDate(row["Content Completed At (if completed)"]) ??
        parseLinkedInDate(row["Content Last Watched Date (if viewed)"]) ??
        snapshotDate();
      return [
        {
          origin_id: stableId("li_learning", [
            title,
            row["Content Last Watched Date (if viewed)"],
            row["Content Completed At (if completed)"],
          ]),
          origin_type: "learning",
          occurred_at: occurredAt,
          payload_text: [
            title,
            row["Content Description"],
            row["Notes taken on videos (if taken)"],
          ]
            .filter(Boolean)
            .join("\n"),
          title,
          metadata: {
            platform: "linkedin",
            content_type: row["Content Type"],
            last_watched_at: row["Content Last Watched Date (if viewed)"],
            completed_at: row["Content Completed At (if completed)"],
            saved: row["Content Saved"],
          },
        },
      ];
    });
  }

  private readEvents(takeoutDir: string): EventEnvelope[] {
    return readCsv(takeoutDir, "Events.csv").flatMap((row) => {
      const name = row["Event Name"];
      if (!name) return [];
      return [
        {
          origin_id: stableId("li_event", [name, row["Event Time"]]),
          origin_type: "event",
          occurred_at:
            parseLinkedInDateStart(row["Event Time"]) ?? snapshotDate(),
          payload_text: [name, row.Status, row["External Url"]]
            .filter(Boolean)
            .join("\n"),
          title: name,
          source_url: row["External Url"],
          metadata: {
            platform: "linkedin",
            event_time: row["Event Time"],
            status: row.Status,
            external_url: row["External Url"],
          },
        },
      ];
    });
  }

  private readEndorsements(takeoutDir: string): EventEnvelope[] {
    const given = readCsv(takeoutDir, "Endorsement_Given_Info.csv").flatMap(
      (row) =>
        this.endorsementEvent({
          row,
          direction: "given",
          person: [row["Endorsee First Name"], row["Endorsee Last Name"]]
            .filter(Boolean)
            .join(" "),
          url: row["Endorsee Public Url"],
        })
    );
    const received = readCsv(
      takeoutDir,
      "Endorsement_Received_Info.csv"
    ).flatMap((row) =>
      this.endorsementEvent({
        row,
        direction: "received",
        person: [row["Endorser First Name"], row["Endorser Last Name"]]
          .filter(Boolean)
          .join(" "),
        url: row["Endorser Public Url"],
      })
    );
    const recommendations = readCsv(
      takeoutDir,
      "Recommendations_Given.csv"
    ).flatMap((row) => {
      const person = [row["First Name"], row["Last Name"]]
        .filter(Boolean)
        .join(" ");
      const occurredAt = parseLinkedInDate(row["Creation Date"]);
      if (!person || !occurredAt) return [];
      return [
        {
          origin_id: stableId("li_recommendation_given", [
            person,
            row.Company,
            row["Creation Date"],
            row.Text,
          ]),
          origin_type: "recommendation_given",
          occurred_at: occurredAt,
          payload_text: row.Text,
          author_name: person,
          title: `Recommendation for ${person}`,
          metadata: {
            platform: "linkedin",
            person,
            company: row.Company,
            job_title: row["Job Title"],
            status: row.Status,
            creation_date: row["Creation Date"],
          },
        },
      ];
    });
    return [...given, ...received, ...recommendations];
  }

  private endorsementEvent(params: {
    row: Record<string, string>;
    direction: "given" | "received";
    person: string;
    url?: string;
  }): EventEnvelope[] {
    const occurredAt = parseLinkedInDate(params.row["Endorsement Date"]);
    if (!params.person || !occurredAt) return [];
    return [
      {
        origin_id: stableId(`li_endorsement_${params.direction}`, [
          params.person,
          params.row["Skill Name"],
          params.row["Endorsement Date"],
        ]),
        origin_type: `endorsement_${params.direction}`,
        occurred_at: occurredAt,
        payload_text: `${params.direction} endorsement: ${params.row["Skill Name"]} - ${params.person}`,
        author_name: params.person,
        source_url: params.url?.startsWith("http")
          ? params.url
          : params.url
            ? `https://${params.url}`
            : undefined,
        metadata: {
          platform: "linkedin",
          direction: params.direction,
          person: params.person,
          skill: params.row["Skill Name"],
          status: params.row["Endorsement Status"],
          endorsement_date: params.row["Endorsement Date"],
        },
      },
    ];
  }

  private readRichMedia(takeoutDir: string): EventEnvelope[] {
    return readCsv(takeoutDir, "Rich_Media.csv").flatMap((row) => {
      const occurredAt = parseLinkedInMediaDate(row["Date/Time"]);
      if (!row["Media Link"]) return [];
      return [
        {
          origin_id: stableId("li_rich_media", [
            row["Date/Time"],
            row["Media Link"],
          ]),
          origin_type: "media",
          occurred_at: occurredAt ?? snapshotDate(),
          payload_text: [row["Date/Time"], row["Media Description"]]
            .filter(Boolean)
            .join("\n"),
          title: row["Media Description"],
          source_url: row["Media Link"],
          metadata: {
            platform: "linkedin",
            date_time: row["Date/Time"],
            media_description: row["Media Description"],
            media_link: row["Media Link"],
          },
        },
      ];
    });
  }
}

function readCsv(
  takeoutDir: string,
  relativePath: string
): Record<string, string>[] {
  const filePath = path.join(takeoutDir, relativePath);
  if (!existsSync(filePath)) return [];
  return parseCsv(readFileSync(filePath, "utf8"));
}

function parseLinkedInDate(input?: string): Date | undefined {
  if (!input || input === "N/A") return undefined;
  const normalized = input.endsWith(" UTC")
    ? input.replace(" UTC", "Z")
    : input;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseLinkedInDateStart(input?: string): Date | undefined {
  return parseLinkedInDate(input?.split(" - ")[0]);
}

function parseLinkedInMediaDate(input?: string): Date | undefined {
  if (!input) return undefined;
  const match = input.match(
    /on ([A-Z][a-z]+ \d{1,2}, \d{4}) at (\d{1,2}:\d{2} [AP]M)/
  );
  return parseLinkedInDate(match ? `${match[1]} ${match[2]}` : input);
}

function snapshotDate(): Date {
  return new Date("1970-01-02T00:00:00.000Z");
}

function localTakeoutSchema(description: string): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      takeout_dir: { type: "string", description },
      batch_size: {
        type: "integer",
        minimum: 1,
        maximum: 5000,
        default: 1000,
        description: "Maximum events to emit per sync run.",
      },
    },
  };
}
