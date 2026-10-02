CREATE TABLE IF NOT EXISTS "teams" (
	"id"	INTEGER NOT NULL,
	"name"	TEXT NOT NULL UNIQUE,
	PRIMARY KEY("id" AUTOINCREMENT)
);
CREATE TABLE members (
  id INTEGER PRIMARY KEY,
  team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  role TEXT CHECK (role IN ('owner', 'member')) DEFAULT 'member',
  meta
) WITHOUT ROWID;
CREATE INDEX members_team ON members(team_id);
CREATE TRIGGER t AFTER INSERT ON members BEGIN UPDATE teams SET name = name WHERE id = NEW.team_id; END;
