-- Privacy flag per channel. Default ORG preserves the legacy behavior
-- (any org member who passes ChannelAgent rules sees the channel; OWNER/ADMIN
-- bypass). PRIVATE narrows it down to explicit grants only — even OWNERs
-- need to be in ChannelAgent to see a private channel.

CREATE TYPE "ChannelVisibility" AS ENUM ('ORG', 'PRIVATE');

ALTER TABLE "channels"
  ADD COLUMN "visibility" "ChannelVisibility" NOT NULL DEFAULT 'ORG';
