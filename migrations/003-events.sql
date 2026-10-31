CREATE TABLE community_events (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE UNIQUE INDEX event_channel ON community_events(json_extract(data,'$.channelId'));
CREATE UNIQUE INDEX event_role ON community_events(json_extract(data,'$.roleId'));
CREATE TABLE event_operations (id TEXT PRIMARY KEY, data TEXT NOT NULL);
