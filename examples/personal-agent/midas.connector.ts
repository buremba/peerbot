import {
  type ChromeActionDispatcher,
  type ConnectorDefinition,
  ConnectorRuntime,
  type SyncContext,
  type SyncResult,
} from "@lobu/connector-sdk";

export interface MidasHolding {
  type: string;
  symbol: string;
  shares: number;
  price: string;
  value: string;
}

export default class MidasConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: "midas",
    name: "Midas",
    description: "Syncs Midas portfolio holdings.",
    version: "1.0.0",
    faviconDomain: "atlas.getmidas.com",
    authSchema: {
      methods: [{ type: "none" }],
    },
    feeds: {
      assets: {
        key: "assets",
        name: "Midas Holdings",
        description: "Scrapes Midas portfolio holdings.",
        configSchema: { type: "object", properties: {} },
        eventKinds: {
          financial_asset: {
            description: "A financial asset holding",
            metadataSchema: {
              type: "object",
              properties: {
                type: { type: "string" },
                symbol: { type: "string" },
                shares: { type: "number" },
                price: { type: "number" },
                value: { type: "number" },
                currency: { type: "string" },
              },
            },
          },
          balance_raw: {
            description: "Midas Total Balance",
            metadataSchema: {
              type: "object",
              properties: {
                balance: { type: "number" },
                currency: { type: "string" },
                total_try: { type: "number" },
              },
            },
          },
        },
      },
    },
    optionsSchema: { type: "object", properties: {} },
  };

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const dispatcher = ctx.channel as unknown as ChromeActionDispatcher;
    if (!dispatcher || typeof dispatcher.dispatch !== "function") {
      throw new Error(
        "MidasConnector requires a ChromeActionDispatcher (Owletto extension)"
      );
    }

    if (ctx.feedKey !== "assets") {
      throw new Error(`Unknown feed: ${ctx.feedKey}`);
    }

    const nav = await dispatcher.dispatch<{ tab_id: number }>("navigate", {
      url: "https://atlas.getmidas.com/dashboard",
      persistent: true,
      window_focused: false,
      wait_for_load: false,
      allowed_origins: ["getmidas.com", "*.getmidas.com"],
    });

    // Wait a bit to ensure it loads
    await new Promise((r) => setTimeout(r, 5000));

    const setup = await dispatcher.dispatch<{ value?: any }>("evaluate", {
      tab_id: nav.tab_id,
      expression: `(() => {
        const text = document.body.innerText;
        const lines = text.split("\\n").map(l => l.trim()).filter(Boolean);
        const holdings = [];
        
        const usStartIdx = lines.indexOf("ABD Hisseleri");
        const trStartIdx = lines.indexOf("BIST Hisseleri");
        
        let usTickers = [];
        let trTickers = [];
        
        if (usStartIdx !== -1 && trStartIdx !== -1) {
          usTickers = lines.slice(usStartIdx + 1, trStartIdx);
        } else if (usStartIdx !== -1) {
          let idx = usStartIdx + 1;
          while(idx < lines.length && isNaN(parseInt(lines[idx]))) {
             usTickers.push(lines[idx]);
             idx++;
          }
        }
        
        let nextIdx = trStartIdx !== -1 ? trStartIdx + 1 : -1;
        if (nextIdx !== -1) {
          while (nextIdx < lines.length && isNaN(parseInt(lines[nextIdx]))) {
            trTickers.push(lines[nextIdx]);
            nextIdx++;
          }
        } else {
          nextIdx = usStartIdx !== -1 ? usStartIdx + 1 + usTickers.length : 0;
        }
        
        let currentIdx = nextIdx;
        
        const parseCurrency = (str) => {
          if (!str) return 0;
          return parseFloat(str.replace(/[^0-9.-]/g, '')) || 0;
        };

        let totalUsd = "0";
        let totalTry = "0";
        
        if (currentIdx < lines.length && usTickers.length > 0) {
          const numUs = parseInt(lines[currentIdx]); 
          currentIdx++;
          totalUsd = lines[currentIdx];
          currentIdx += 3;
          
          for (let i = 0; i < usTickers.length; i++) {
            holdings.push({
              symbol: usTickers[i],
              shares: parseFloat(lines[currentIdx]?.replace(",", ".") || "0"),
              price: parseCurrency(lines[currentIdx+1]),
              value: parseCurrency(lines[currentIdx+3]),
              currency: "USD",
              type: "US"
            });
            currentIdx += 7;
          }
        }
        
        if (currentIdx < lines.length && trTickers.length > 0) {
          const numTr = parseInt(lines[currentIdx]);
          currentIdx++;
          totalTry = lines[currentIdx];
          currentIdx += 3;
          
          for (let i = 0; i < trTickers.length; i++) {
            holdings.push({
              symbol: trTickers[i],
              shares: parseFloat(lines[currentIdx]?.replace(".", "").replace(",", ".") || "0"),
              price: parseCurrency(lines[currentIdx+1]),
              value: parseCurrency(lines[currentIdx+3]),
              currency: "TRY",
              type: "TR"
            });
            currentIdx += 7;
          }
        }

        return { total_usd: parseCurrency(totalUsd), total_try: parseCurrency(totalTry), holdings };
      })()`,
      allowed_origins: ["getmidas.com", "*.getmidas.com"],
    });

    if (!setup.value || !setup.value.holdings) {
      throw new Error(
        "Failed to parse Midas dashboard. Make sure you are logged in."
      );
    }

    const data = setup.value;
    const events = [];

    for (const h of data.holdings) {
      events.push({
        origin_id: "midas-holding-" + h.symbol,
        title: "Midas Holding: " + h.symbol,
        occurred_at: new Date().toISOString(),
        semantic_type: "financial_asset",
        metadata: h,
      });
    }

    events.push({
      origin_id: "midas-balance",
      title: "Midas Balance",
      occurred_at: new Date().toISOString(),
      semantic_type: "balance_raw",
      metadata: {
        balance: data.total_usd,
        currency: "USD",
        total_try: data.total_try,
      },
    });

    return {
      events,
      checkpoint: { last_run: new Date().toISOString() } as unknown as Record<
        string,
        unknown
      >,
      metadata: { items_found: events.length },
    };
  }

  async execute(ctx: any): Promise<any> {
    throw new Error("Not implemented");
  }
}
