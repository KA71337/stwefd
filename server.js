const express = require('express');
const cors = require('cors');
const path = require('path');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// Store active sessions
const sessions = new Map();

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
});

// Serve HTML
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Connect to Telegram
app.post('/api/connect', async (req, res) => {
    try {
        const { apiId, apiHash, phoneNumber, code, password } = req.body;

        console.log('Connection request:', { apiId, phoneNumber, hasCode: !!code });

        if (!apiId || !apiHash || !phoneNumber) {
            return res.status(400).json({ error: 'Missing required fields: apiId, apiHash, phoneNumber' });
        }

        const sessionKey = `${phoneNumber}_${apiId}`;
        let client = sessions.get(sessionKey);

        if (!client) {
            const session = new StringSession('');
            client = new TelegramClient(session, parseInt(apiId), apiHash, {
                connectionRetries: 5,
            });

            console.log('Starting Telegram client...');

            await client.connect();

            if (!client.connected) {
                throw new Error('Failed to connect to Telegram');
            }

            // Send code if not provided
            if (!code) {
                console.log('Sending code to phone...');
                await client.sendCode({
                    apiId: parseInt(apiId),
                    apiHash: apiHash,
                }, phoneNumber);

                sessions.set(sessionKey, client);
                return res.json({
                    success: true,
                    needsCode: true,
                    message: 'Verification code sent to your Telegram app'
                });
            }

            // Sign in with code
            console.log('Signing in with code...');
            try {
                await client.signInUser({
                    apiId: parseInt(apiId),
                    apiHash: apiHash,
                }, {
                    phoneNumber: async () => phoneNumber,
                    phoneCode: async () => code,
                    password: async () => password || '',
                    onError: (err) => {
                        console.error('Sign in error:', err);
                    },
                });
            } catch (error) {
                if (error.message.includes('PHONE_CODE_INVALID')) {
                    return res.status(400).json({ error: 'Invalid verification code' });
                }
                if (error.message.includes('SESSION_PASSWORD_NEEDED')) {
                    return res.json({
                        success: true,
                        needsPassword: true,
                        message: 'Two-factor authentication enabled. Please provide password.'
                    });
                }
                throw error;
            }

            const sessionString = client.session.save();
            sessions.set(sessionKey, client);

            console.log('Successfully connected!');

            return res.json({
                success: true,
                message: 'Successfully connected to Telegram',
                session: sessionString
            });
        } else {
            // Client already exists
            if (!client.connected) {
                await client.connect();
            }

            return res.json({
                success: true,
                message: 'Already connected',
                session: client.session.save()
            });
        }
    } catch (error) {
        console.error('Connection error:', error);
        res.status(500).json({
            error: error.message,
            details: 'Make sure your credentials are correct'
        });
    }
});

// Search channels with real Telegram API
app.post('/api/search-channels', async (req, res) => {
    try {
        const { keywords, minSubscribers, maxSubscribers, apiId, phoneNumber } = req.body;

        console.log('Search request:', { keywords, minSubscribers, maxSubscribers });

        if (!keywords || keywords.length === 0) {
            return res.status(400).json({ error: 'Keywords are required' });
        }

        const sessionKey = `${phoneNumber}_${apiId}`;
        const client = sessions.get(sessionKey);

        if (!client || !client.connected) {
            return res.status(401).json({
                error: 'Not connected to Telegram. Please connect first.'
            });
        }

        const allChannels = [];
        const seenIds = new Set();

        // Search for each keyword
        for (const keyword of keywords) {
            try {
                console.log(`Searching for keyword: ${keyword}`);

                // Use Telegram's global search
                const result = await client.invoke(
                    new Api.contacts.Search({
                        q: keyword,
                        limit: 50
                    })
                );

                console.log(`Found ${result.chats.length} results for "${keyword}"`);

                // Process each chat
                for (const chat of result.chats) {
                    // Only process channels (not groups)
                    if (chat.className === 'Channel' && !chat.megagroup && !seenIds.has(chat.id.toString())) {
                        try {
                            // Get full channel info
                            const fullChannel = await client.invoke(
                                new Api.channels.GetFullChannel({
                                    channel: chat
                                })
                            );

                            const participantsCount = fullChannel.fullChat.participantsCount || 0;

                            // Check if channel meets criteria
                            if (participantsCount >= minSubscribers &&
                                participantsCount <= maxSubscribers) {

                                // Check if discussion (comments) are enabled
                                const hasDiscussion = !fullChannel.fullChat.flags || !fullChannel.fullChat.flags.noComments;

                                if (hasDiscussion) {
                                    seenIds.add(chat.id.toString());

                                    allChannels.push({
                                        id: chat.id.toString(),
                                        name: chat.title,
                                        username: chat.username || null,
                                        subscribers: participantsCount,
                                        description: fullChannel.fullChat.about || '',
                                        verified: chat.verified || false,
                                        keyword: keyword,
                                        hasComments: true
                                    });

                                    console.log(`Added channel: ${chat.title} (${participantsCount} subscribers)`);
                                }
                            }
                        } catch (err) {
                            console.error(`Error getting channel details for ${chat.title}:`, err.message);
                        }

                        // Add small delay to avoid rate limiting
                        await new Promise(resolve => setTimeout(resolve, 100));
                    }
                }

                // Delay between keyword searches
                await new Promise(resolve => setTimeout(resolve, 500));

            } catch (err) {
                console.error(`Error searching for keyword "${keyword}":`, err.message);
            }
        }

        console.log(`Total channels found: ${allChannels.length}`);

        res.json({
            success: true,
            channels: allChannels,
            total: allChannels.length
        });

    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({
            error: error.message,
            details: 'Error searching for channels'
        });
    }
});

// Subscribe to channels
app.post('/api/subscribe', async (req, res) => {
    try {
        const { channelLinks, apiId, phoneNumber } = req.body;

        const sessionKey = `${phoneNumber}_${apiId}`;
        const client = sessions.get(sessionKey);

        if (!client || !client.connected) {
            return res.status(401).json({
                error: 'Not connected to Telegram'
            });
        }

        const results = [];

        for (const link of channelLinks) {
            try {
                const username = link.replace('https://t.me/', '').replace('@', '');

                console.log(`Joining channel: ${username}`);

                // Get channel entity
                const channel = await client.getEntity(username);

                // Join the channel
                await client.invoke(
                    new Api.channels.JoinChannel({
                        channel: channel
                    })
                );

                results.push({
                    channel: link,
                    username: username,
                    success: true,
                    message: 'Successfully joined'
                });

                console.log(`Joined: ${username}`);

                // Delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 2000));

            } catch (err) {
                console.error(`Error joining ${link}:`, err.message);
                results.push({
                    channel: link,
                    success: false,
                    error: err.message
                });
            }
        }

        res.json({
            success: true,
            results: results,
            joined: results.filter(r => r.success).length,
            failed: results.filter(r => !r.success).length
        });

    } catch (error) {
        console.error('Subscribe error:', error);
        res.status(500).json({
            error: error.message
        });
    }
});

// Comment on channels
let commentingActive = false;
let commentingInterval = null;

app.post('/api/comment', async (req, res) => {
    try {
        const { channelLinks, commentText, interval, apiId, phoneNumber } = req.body;

        const sessionKey = `${phoneNumber}_${apiId}`;
        const client = sessions.get(sessionKey);

        if (!client || !client.connected) {
            return res.status(401).json({
                error: 'Not connected to Telegram'
            });
        }

        commentingActive = true;

        // Start commenting in background
        (async () => {
            while (commentingActive) {
                for (const link of channelLinks) {
                    if (!commentingActive) break;

                    try {
                        const username = link.replace('https://t.me/', '').replace('@', '');

                        console.log(`Commenting on: ${username}`);

                        // Get channel
                        const channel = await client.getEntity(username);

                        // Get recent messages
                        const messages = await client.getMessages(channel, { limit: 5 });

                        if (messages && messages.length > 0) {
                            const latestMessage = messages[0];

                            // Send comment (reply to latest post)
                            await client.sendMessage(channel, {
                                message: commentText,
                                replyTo: latestMessage.id
                            });

                            console.log(`Comment sent to ${username}`);
                        }
                    } catch (err) {
                        console.error(`Error commenting on ${link}:`, err.message);
                    }

                    // Wait for specified interval
                    await new Promise(resolve => setTimeout(resolve, interval * 1000));
                }
            }
        })();

        res.json({
            success: true,
            message: 'Commenting started',
            interval: interval,
            channels: channelLinks.length
        });

    } catch (error) {
        console.error('Comment error:', error);
        res.status(500).json({
            error: error.message
        });
    }
});

// Stop commenting
app.post('/api/stop-commenting', (req, res) => {
    commentingActive = false;
    console.log('Commenting stopped');

    res.json({
        success: true,
        message: 'Commenting stopped'
    });
});

// Disconnect
app.post('/api/disconnect', async (req, res) => {
    try {
        const { apiId, phoneNumber } = req.body;
        const sessionKey = `${phoneNumber}_${apiId}`;
        const client = sessions.get(sessionKey);

        if (client) {
            await client.disconnect();
            sessions.delete(sessionKey);
        }

        res.json({
            success: true,
            message: 'Disconnected from Telegram'
        });
    } catch (error) {
        res.status(500).json({
            error: error.message
        });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════╗
║   Telegram Channel Automation Server                 ║
║   Server running on port ${PORT}                     ║
║   Environment: ${process.env.NODE_ENV || 'development'}                     ║
╚══════════════════════════════════════════════════════╝
    `);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM received, closing server...');
    
    // Disconnect all Telegram clients
    for (const [key, client] of sessions.entries()) {
        try {
            await client.disconnect();
            console.log(`Disconnected session: ${key}`);
        } catch (err) {
            console.error(`Error disconnecting ${key}:`, err);
        }
    }
    
    process.exit(0);
});
