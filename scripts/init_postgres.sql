-- Executed once by the Compose database entrypoint. The bootstrap administrator
-- remains available through the database container's local Unix socket.
\getenv app_password POSTGRES_PASSWORD
CREATE ROLE pocketmark LOGIN PASSWORD :'app_password';
ALTER DATABASE pocketmark OWNER TO pocketmark;
ALTER ROLE postgres PASSWORD NULL;
