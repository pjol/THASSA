-- DM post sharing: a message can carry a shared post, rendered as a tappable
-- post card in the thread. SET NULL keeps the message if the post is deleted.
ALTER TABLE messages ADD COLUMN post_id UUID REFERENCES posts(id) ON DELETE SET NULL;
