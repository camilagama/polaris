CREATE TABLE "db_poc_operations" (
	"id" serial PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	CONSTRAINT "db_poc_operations_token_unique" UNIQUE("token")
);
