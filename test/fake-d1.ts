/*
 * テスト用の D1。Node.js の node:sqlite の上に、sigw が使う分だけの D1 の API を作る。
 * migrations/ の SQL をそのまま流すので、スキーマは本番と同じになる。
 * tsconfig.json は Node.js の型を読まないので、node: のモジュールは型を自分で書いて動的に読む。
 */

interface SqliteStatement {
	all(...params: unknown[]): Record<string, unknown>[];
}

interface SqliteDatabase {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
}

interface NodeFs {
	readdirSync(path: URL): string[];
	readFileSync(path: URL, encoding: "utf8"): string;
}

const sqliteModule = "node:sqlite";
const fsModule = "node:fs";
const { DatabaseSync } = (await import(sqliteModule)) as {
	DatabaseSync: new (path: string) => SqliteDatabase;
};
const fs = (await import(fsModule)) as NodeFs;

// tsconfig.json の型では import.meta.url がないので、形を書いて読む
const migrationsDir = new URL(
	"../migrations/",
	(import.meta as unknown as { url: string }).url,
);

class FakeStatement {
	private readonly db: SqliteDatabase;
	readonly sql: string;
	private readonly params: unknown[];

	constructor(db: SqliteDatabase, sql: string, params: unknown[] = []) {
		this.db = db;
		this.sql = sql;
		this.params = params;
	}

	bind(...params: unknown[]): FakeStatement {
		for (const param of params) {
			if (param === undefined) {
				throw new Error(`D1 では undefined を bind できません: ${this.sql}`);
			}
		}
		return new FakeStatement(this.db, this.sql, params);
	}

	execute(): { results: Record<string, unknown>[]; changes: number } {
		const results = this.db.prepare(this.sql).all(...this.params);
		const changes = Number(
			this.db.prepare("SELECT changes() AS c").all()[0]?.c ?? 0,
		);
		return { results, changes };
	}

	async all() {
		const { results, changes } = this.execute();
		return { results, success: true, meta: { changes } };
	}

	async first(column?: string) {
		const row = this.execute().results[0] ?? null;
		return column && row ? row[column] : row;
	}

	async run() {
		return this.all();
	}
}

export class FakeD1 {
	readonly sqlite: SqliteDatabase;

	/**
	 * before を渡すと、そのマイグレーション(例 "0007")の手前までだけを流す。
	 * マイグレーションで行を移すテストでは、行を入れてから migrate() で残りを流す
	 */
	constructor(options: { before?: string } = {}) {
		this.sqlite = new DatabaseSync(":memory:");
		this.sqlite.exec("PRAGMA foreign_keys = ON");
		this.migrate(options.before ? { before: options.before } : {});
	}

	private applied = new Set<string>();

	/** まだ流していないマイグレーションを、名前の順に流す */
	migrate(options: { before?: string } = {}): void {
		const files = fs
			.readdirSync(migrationsDir)
			.filter((name) => name.endsWith(".sql"))
			.sort();
		for (const file of files) {
			if (this.applied.has(file)) continue;
			if (options.before && file >= options.before) break;
			this.sqlite.exec(fs.readFileSync(new URL(file, migrationsDir), "utf8"));
			this.applied.add(file);
		}
	}

	prepare(sql: string): FakeStatement {
		return new FakeStatement(this.sqlite, sql);
	}

	/** D1 と同じく、まとめて1つのトランザクションで流す */
	async batch(statements: FakeStatement[]) {
		this.sqlite.exec("BEGIN");
		try {
			const out = statements.map((statement) => {
				const { results, changes } = statement.execute();
				return { results, success: true, meta: { changes } };
			});
			this.sqlite.exec("COMMIT");
			return out;
		} catch (error) {
			this.sqlite.exec("ROLLBACK");
			throw error;
		}
	}

	withSession(): FakeD1 {
		return this;
	}

	/** テストで中身を確かめるための SELECT */
	rows(sql: string, ...params: unknown[]): Record<string, unknown>[] {
		return this.sqlite.prepare(sql).all(...params);
	}

	asD1(): D1Database {
		return this as unknown as D1Database;
	}
}
