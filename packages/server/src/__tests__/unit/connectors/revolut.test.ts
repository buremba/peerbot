import { describe, expect, it } from "vitest";
import {
	extractTransactionsFromResponse,
	filterTransactionsSinceCheckpoint,
	type RevolutTransaction,
	transactionToEvent,
} from "../../../../../connectors/src/revolut";

describe("Revolut transaction parsing", () => {
	it("parses the legacy retail transaction shape (minor units, ms epoch)", () => {
		const response = {
			transactions: [
				{
					id: "tx_1",
					type: "CARD_PAYMENT",
					state: "COMPLETED",
					startedDate: 1719705600000,
					completedDate: 1719705660000, // 2024-06-30
					amount: -2000,
					currency: "GBP",
					balance: 1740589,
					description: "The Chancellors",
				},
				{
					id: "tx_2",
					type: "TOPUP",
					state: "COMPLETED",
					completedDate: 1721318400000, // 2024-07-18
					amount: 5000,
					currency: "GBP",
					balance: 1745589,
					merchant: { name: "Apple Pay top-up" },
				},
			],
		};

		const txns = extractTransactionsFromResponse(response);
		expect(txns).toHaveLength(2);

		const [a, b] = txns;
		expect(a).toMatchObject({
			id: "tx_1",
			description: "The Chancellors",
			amount: 20,
			direction: "out",
			balance: 17405.89,
			currency: "GBP",
			date: "2024-06-30",
			type: "CARD_PAYMENT",
			state: "COMPLETED",
		});
		expect(b).toMatchObject({
			id: "tx_2",
			description: "Apple Pay top-up",
			amount: 50,
			direction: "in",
			balance: 17455.89,
			currency: "GBP",
		});
	});

	it("handles nested money objects and ISO timestamps", () => {
		const txns = extractTransactionsFromResponse([
			{
				id: "tx_3",
				state: "PENDING",
				valueDate: "2025-01-15T09:30:00.000Z",
				amount: { value: -799, currency: "EUR" },
				description: "Spotify",
			},
		]);
		expect(txns).toEqual([
			expect.objectContaining({
				id: "tx_3",
				amount: 7.99,
				direction: "out",
				currency: "EUR",
				date: "2025-01-15",
				state: "PENDING",
			}),
		]);
	});

	it("keeps zero-decimal currencies unscaled", () => {
		const [txn] = extractTransactionsFromResponse([
			{
				id: "tx_vnd",
				state: "COMPLETED",
				completedDate: "2024-07-19",
				amount: -120000,
				currency: "VND",
				description: "Song Que Cafe",
			},
		]);
		expect(txn.amount).toBe(120000);
		expect(txn.currency).toBe("VND");
	});

	it("skips records without a timestamp or without money, and declined states", () => {
		const txns = extractTransactionsFromResponse({
			budgets: [{ amount: 50000, currency: "GBP", name: "Groceries" }], // no date
			pending: [
				{
					id: "x",
					state: "DECLINED",
					completedDate: 1719705600000,
					amount: -1,
					currency: "GBP",
				},
			],
			misc: { hello: "world" },
		});
		expect(txns).toEqual([]);
	});
});

describe("Revolut checkpoint filtering", () => {
	const make = (id: string, iso: string): RevolutTransaction => ({
		id,
		description: id,
		amount: 1,
		direction: "out",
		currency: "GBP",
		date: iso.slice(0, 10),
		occurredAt: new Date(iso),
	});

	it("drops transactions at or before the saved timestamp and dedups by id", () => {
		const txns = [
			make("103", "2026-03-29T12:00:00.000Z"),
			make("102", "2026-03-28T12:00:00.000Z"),
			make("102", "2026-03-28T12:00:00.000Z"),
			make("101", "2026-03-27T12:00:00.000Z"),
		];
		expect(
			filterTransactionsSinceCheckpoint(txns, {
				last_transaction_id: "102",
				last_timestamp: "2026-03-28T12:00:00.000Z",
			}).map((t) => t.id),
		).toEqual(["103"]);
	});

	it("returns everything when there is no checkpoint", () => {
		const txns = [
			make("2", "2026-03-29T12:00:00.000Z"),
			make("1", "2026-03-28T12:00:00.000Z"),
		];
		expect(
			filterTransactionsSinceCheckpoint(txns, null).map((t) => t.id),
		).toEqual(["2", "1"]);
	});
});

describe("Revolut event mapping", () => {
	it("produces the legacy event shape", () => {
		const event = transactionToEvent({
			id: "tx_1",
			description: "The Chancellors",
			amount: 20,
			direction: "out",
			balance: 17405.89,
			currency: "GBP",
			date: "2024-06-30",
			occurredAt: new Date("2024-06-30T12:01:00.000Z"),
			type: "CARD_PAYMENT",
			state: "COMPLETED",
		});
		expect(event.origin_id).toBe("revolut-tx_1");
		expect(event.semantic_type).toBe("transaction");
		expect(event.payload_text).toBe("The Chancellors -£20 on 2024-06-30");
		expect(event.metadata).toMatchObject({
			date: "2024-06-30",
			description: "The Chancellors",
			amount: 20,
			direction: "out",
			balance: 17405.89,
			currency: "GBP",
			transaction_type: "CARD_PAYMENT",
			state: "COMPLETED",
		});
	});
});
