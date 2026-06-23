/**
 * Calendar Connector — Lobu for Mac only.
 *
 * Reads the user's calendar events via EventKit on the Mac (Lobu for Mac
 * advertises the `calendar` capability). One event per occurrence in a
 * rolling window around now; titles/times/locations/attendees flow up, the
 * underlying calendar database stays on the device.
 */

import { BridgeOnlyConnector, type ConnectorDefinition } from '@lobu/connector-sdk';

const BRIDGE_ONLY =
  'apple.calendar runs only on a worker advertising capability "calendar" (Lobu for Mac with Calendar access).';

export default class AppleCalendarConnector extends BridgeOnlyConnector {
  constructor() {
    super(BRIDGE_ONLY);
  }

  readonly definition: ConnectorDefinition = {
    key: 'apple.calendar',
    name: 'Calendar',
    description:
      'Sync your calendar events (titles, times, locations, attendees) from this Mac via Lobu for Mac. Events stay on the device.',
    version: '0.1.0',
    faviconDomain: 'apple.com',
    requiredCapability: 'calendar',
    runtime: { platforms: ['macos'] },
    authSchema: { methods: [{ type: 'none' }] },
    feeds: {
      events: {
        key: 'events',
        name: 'Events',
        description: 'Calendar events from the Mac, in a rolling window around now.',
        configSchema: { type: 'object', properties: {} },
        eventKinds: {
          calendar_event: {
            description: 'A single calendar event occurrence.',
            metadataSchema: {
              type: 'object',
              required: ['source', 'origin_id', 'start'],
              properties: {
                source: { type: 'string', const: 'apple_calendar' },
                origin_id: { type: 'string' },
                calendar: { type: 'string' },
                start: { type: 'string' },
                end: { type: 'string' },
                all_day: { type: 'boolean' },
                location: { type: 'string' },
                organizer: { type: 'string' },
                attendee_count: { type: 'integer' },
              },
            },
          },
        },
      },
    },
  };
}
