import {
    composeContext,
    generateText,
    ModelClass,
    type IAgentRuntime,
    elizaLogger,
    stringToUuid,
    cleanJsonResponse,
    UUID,
    truncateToCompleteSentence,
    getEmbeddingZeroVector,
} from "@elizaos/core";
import type { ClientBase } from "./base";
import { DEFAULT_MAX_TWEET_LENGTH, TwitterConfig } from "./environment";
import { SearchMode, type Tweet } from "agent-twitter-client";
import { wait } from "./utils";
import { MediaData } from "./types";

const dailyAnalysisTemplate = `
Please analyze the following tweets to extract key themes and trends:
Current tweets (total {{twitterCount}}, {{formattedTweets}})

Contents to be analyzed:
1. Identify 3-5 main discussion topics (sort by frequency)
2. Count the number of relevant tweets for each topic
3. Mark significant sentiment (positive/neutral/negative)
4. Discover any discussion trends across users
5. Identify important tweets with multiple citations

Please return the analysis results in JSON format, including the following fields:
- themes: array of themes (including name, quantity, emotion)
- trends: trend description (1-3 items)
- top_mentions: The top 3 users with the most mentions
- notable_tweets: array of notable tweet IDs
`

const dailyReportTemplate = `
# DAILY REPORT GENERATION TASK
{{summaryData}}

# ABOUT {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{postDirections}}

# INSTRUCTIONS:
1. Generate a concise English daily report in bullet points
2. Highlight key trends from target users' tweets
3. Contains three parts: "Daily Insights", "Hot Topics", and "Trend Observation"
4. List relevant tweet links for each topic
5. Use a lighthearted tone that's appropriate for social media
6. Use emojis for visual appeal (max 3)
7. Format requirements:
   - Start with 📊 **Daily Insights**
   - 3-5 main points
   - Each bullet point occupies one line
   - Each point < 100 characters
   - Total length < 280 characters
   - Include relevant hashtags (max 2)

# EXAMPLE:
📊 Daily Insights
• 63% discussed AI + DeFi integration 🤖 - ICP's AI-powered smart contracts are gaining traction in DeFi, improving execution efficiency1.
• OpenChat’s user growth up 28% 🚀 - The decentralized social app on ICP now hosts 2M+ active users7.
• BTC-ICP Chain Fusion adoption rising 🔗 - Over 15 projects now leverage direct Bitcoin smart contracts2.
🏅 Hot Topics
• "Sovereign Cloud" by DFINITY ☁️ - The Utopia project aims for censorship-resistant AI/cloud infrastructure1.
• ICP's 25K TPS milestone ⚡ - Now the fastest blockchain, surpassing Solana & Aptos2.
• DeFi TVL surges 1459% on Sui 📈 - Move-language rival highlights competitive pressure16.
🔍 Trend Observations
• AI agents on ICP 🤖 - Decentralized AI models now interact directly with smart contracts1.
• Long-term AGI roadmaps ⏳ - ICP's DAO governance is exploring AI alignment frameworks17.
• Regulatory scrutiny 🛡️ - New SEC guidelines may impact ICP's DeFi integrations6.
#ICP #BlockchainTrends #DeFi #AICrypto

# CURRENT DATA:
{{formattedTweets}}
`;

export class DailyReportClient {
    client: ClientBase;
    runtime: IAgentRuntime;
    twitterUsername: string;
    private isDryRun: boolean;
    private isProcessing = false;

    constructor(client: ClientBase, runtime: IAgentRuntime) {
        this.client = client;
        this.runtime = runtime;
        this.twitterUsername = this.client.twitterConfig.TWITTER_USERNAME;
        this.isDryRun = this.client.twitterConfig.TWITTER_DRY_RUN;

        // Log configuration on initialization
        elizaLogger.log("Twitter Client Configuration:");
        elizaLogger.log(`- Username: ${this.twitterUsername}`);
        elizaLogger.log(
            `- Dry Run Mode: ${this.isDryRun ? "enabled" : "disabled"}`
        );

        const targetUsers = this.client.twitterConfig.TWITTER_TARGET_USERS;
        if (targetUsers) {
            elizaLogger.log(`- Target Users: ${targetUsers}`);
        }

        elizaLogger.log(
            `- Daily Report Enabled: ${
                this.client.twitterConfig.DAILY_REPORT_ENABLE
                    ? "enabled"
                    : "disabled"
            }`
        );

        if (this.isDryRun) {
            elizaLogger.log(
                "Twitter client initialized in dry run mode - no actual tweets should be posted"
            );
        }
    }

    async start() {
        // const DailyReportLoop = async () => {
        //     try {
        //         if (this.shouldGenerateDigest()) {
        //             await this.runDailyReport();
        //         }
        //     } catch (error) {
        //         elizaLogger.error("Daily Report generation failed:", error);
        //     }
            
            // 每天检查一次
            // setTimeout(DailyReportLoop, 24 * 60 * 60 * 1000);
        // }

        elizaLogger.info("------------------------------------start()--DailyReportLoop----------------------------------------------");

        // 初始启动
        // setTimeout(DailyReportLoop, this.getNextRunTime());
        await this.runDailyReport();
        elizaLogger.log("Daily report scheduler started");
    }

    private shouldGenerateDigest(): boolean {

        elizaLogger.info("------------------------------------shouldGenerateDigest()------------------------------------------------");

        const today = new Date().toISOString().split('T')[0];
        // return today !== this.lastProcessedDate;
        return true;
    }

    private getNextRunTime(): number {
        const now = new Date();
        const [targetHour, targetMinute] = this.client.twitterConfig.DAILY_REPORT_TIME.split(':').map(Number);
        const targetTime = new Date(now);
        
        targetTime.setHours(targetHour, targetMinute, 0, 0);
        
        if (now > targetTime) {
            targetTime.setDate(targetTime.getDate() + 1);
        }
        
        elizaLogger.info("------------------------------------getNextRunTime()------------------------------------------------");

        return targetTime.getTime() - now.getTime();
    }

    async runDailyReport() {
        if (this.isProcessing || !this.client.twitterConfig.TWITTER_TARGET_USERS) {
            return;
        }

        const roomId = stringToUuid( "twitter_dailyreport_room-" + this.twitterUsername );

        this.isProcessing = true;
        try {
            // 1. 收集目标用户推文
            const tweetsByUser = await this.collectTargetUsersTweets();

            // 2. 分析生成摘要
            const summary = await this.generateTrendSummary(tweetsByUser, roomId);
            
            // 3. 生成日报推文
            const reportContent = await this.generateReportContent(summary, roomId);

            // 4. 发布推文
            await this.postDailyReport(reportContent, roomId);

            elizaLogger.log("Daily report published successfully");
        } catch (error) {
            elizaLogger.error("Failed to generate daily report:", error);
        } finally {
            this.isProcessing = false;
        }
    }

    private async collectTargetUsersTweets(): Promise<Tweet[]> {
        // Create a map to store tweets by user
        const tweetsByUser: Tweet[] = [];

        elizaLogger.info("------------------------------------collectTargetUsersTweets()------------------------------------------------");


        if (this.client.twitterConfig.TWITTER_TARGET_USERS.length) {
            const TARGET_USERS = this.client.twitterConfig.TWITTER_TARGET_USERS;

            elizaLogger.log("Processing target users:", TARGET_USERS);

            if (TARGET_USERS.length > 0) {

                // Fetch tweets from all target users
                for (const username of TARGET_USERS) {
                    try {
                        const userTweets = (
                            await this.client.twitterClient.fetchSearchTweets(
                                `from:${username}`,
                                3,
                                SearchMode.Latest
                            )
                        ).tweets;

                        // Filter for recent tweets
                        const validTweets = userTweets.filter((tweet) => {
                            const isRecent = 
                                Date.now() - tweet.timestamp < 24 * 60 * 60;
                        
                            elizaLogger.log(`Tweet ${tweet.id} checks:`, {
                                isRecent,
                                isRetweet: tweet.isRetweet,
                            });
                            return (
                                !tweet.isRetweet &&
                                isRecent
                            );
                        });

                        if (validTweets.length > 0) {
                            tweetsByUser.push(...validTweets);
                            elizaLogger.log(
                                `Found ${validTweets.length} valid tweets from ${username}`
                            );
                        }
                        tweetsByUser.push(...userTweets);

                        await wait(Math.random() * 1000 + 2500); // 防止速率限制
        
                    } catch (error) {
                        elizaLogger.error(
                            `Error fetching tweets for ${username}:`,
                            error
                        );
                        continue;                        
                    }
                }
            } else {
                elizaLogger.log( "No target users configured");
            }
        }

        return tweetsByUser;
    }

    private async generateTrendSummary(tweets: Tweet[], roomId: UUID): Promise<string> {

        elizaLogger.info("------------------------------------generateTrendSummary(1)------------------------------------------------");

        // 基础分析
        const analysis = {
            totalTweets: tweets.length,
            topHashtags: this.getTopHashtags(tweets),
            sentiment: this.analyzeSentiment(tweets),
            mostEngagedTweet: this.findMostEngagedTweet(tweets)
        };

        elizaLogger.info("------------------------------------generateTrendSummary(2)------------------------------------------------");

        // 用AI模型生成洞察
        const state = await this.runtime.composeState(
            {
                userId: this.runtime.agentId,
                roomId,
                agentId: this.runtime.agentId,
                content: { text: JSON.stringify(analysis, null, 2), },
            },
            {
                twitterUserName: this.twitterUsername,
                twitterCount: analysis.totalTweets,
                formattedTweets: analysis.mostEngagedTweet 
                    ? `Most Popular Tweet:\n"${analysis.mostEngagedTweet.text}"\n`
                      + `Likes: ${analysis.mostEngagedTweet.likes} | `
                      + `Retweets: ${analysis.mostEngagedTweet.retweets}`
                    : "No notable tweets today"
            }
        );

        elizaLogger.info("------------------------------------generateTrendSummary(3)------------------------------------------------");

        const context = composeContext({
            state,
            template: dailyAnalysisTemplate
        });

        elizaLogger.info("------------------------------------generateTrendSummary(4)------------------------------------------------");

        return generateText({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.LARGE
        }).then(cleanJsonResponse);
    }

    private async generateReportContent(summary: string, roomId: UUID): Promise<string> {

        elizaLogger.info("------------------------------------generateReportContent(1)------------------------------------------------");

        const state = await this.runtime.composeState(
            {
                userId: this.runtime.agentId,
                roomId,
                agentId: this.runtime.agentId,
                content: { text: summary },
            },
            {}
        );
        
        elizaLogger.info("------------------------------------generateReportContent(2)------------------------------------------------");
            
        const context = composeContext({
            state,
            template: dailyReportTemplate
        });

        elizaLogger.info("------------------------------------generateReportContent(3)------------------------------------------------");

        return generateText({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.LARGE
        });
    }

    private async postDailyReport(content: string, roomId: UUID) {

        elizaLogger.info("------------------------------------postDailyReport()------------------------------------------------");

        await this.postTweet(
            this.runtime,
            this.client,
            content,
            roomId,
            content,
            this.twitterUsername
        );
    }

    // ------------ Helper Methods ------------
    // ["AI", "Tech", "Tech", "News", "AI"] => ["AI", "Tech"]
    private getTopHashtags(tweets: Tweet[], limit = 3): string[] {

        elizaLogger.info("------------------------------------getTopHashtags()------------------------------------------------");

        const hashtagCount = tweets
            .flatMap(t => t.hashtags)
            .reduce((acc, tag) => {
                acc[tag] = (acc[tag] || 0) + 1;
                return acc;
            }, {});

        const results = Object.entries(hashtagCount)
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit)
            .map(([tag]) => tag);
        elizaLogger.info("------------------------------------getTopHashtags()---results--------"+results);

        return results;
    }

    private analyzeSentiment(tweets: Tweet[]): { positive: number; neutral: number; negative: number } {

        elizaLogger.info("------------------------------------analyzeSentiment()------------------------------------------------");

        const scores = tweets.map(t => {
            const text = t.text.toLowerCase();
            if (/(great|awesome|amazing)/.test(text)) return 1;
            if (/(bad|terrible|disappointing)/.test(text)) return -1;
            return 0;
        });

        elizaLogger.info("------------------------------------analyzeSentiment()---scores-----"+scores);

        return {
            positive: scores.filter(s => s > 0).length,
            neutral: scores.filter(s => s === 0).length,
            negative: scores.filter(s => s < 0).length
        };
    }

    private findMostEngagedTweet(tweets: Tweet[]): Tweet | null {

        elizaLogger.info("------------------------------------findMostEngagedTweet()------------------------------------------------");

        return tweets.reduce((prev, current) => 
            (prev.likes + prev.retweets) > (current.likes + current.retweets) ? prev : current
        , { likes: 0, retweets: 0 } as Tweet);
    }

    async postTweet(
        runtime: IAgentRuntime,
        client: ClientBase,
        tweetTextForPosting: string,
        roomId: UUID,
        rawTweetContent: string,
        twitterUsername: string,
        mediaData?: MediaData[]
    ) {
        try {
            elizaLogger.log(`Posting new tweet:\n`);

            let result;

            if (tweetTextForPosting.length > DEFAULT_MAX_TWEET_LENGTH) {
                result = await this.handleNoteTweet(
                    client,
                    tweetTextForPosting,
                    undefined,
                    mediaData
                );
            } else {
                result = await this.sendStandardTweet(
                    client,
                    tweetTextForPosting,
                    undefined,
                    mediaData
                );
            }

            const tweet = this.createTweetObject(
                result,
                client,
                twitterUsername
            );

            await this.processAndCacheTweet(
                runtime,
                client,
                tweet,
                roomId,
                rawTweetContent
            );
        } catch (error) {
            elizaLogger.error("Error sending tweet:", error);
        }
    }

    async handleNoteTweet(
        client: ClientBase,
        content: string,
        tweetId?: string,
        mediaData?: MediaData[]
    ) {
        try {
            const noteTweetResult = await client.requestQueue.add(
                async () =>
                    await client.twitterClient.sendNoteTweet(
                        content,
                        tweetId,
                        mediaData
                    )
            );

            if (noteTweetResult.errors && noteTweetResult.errors.length > 0) {
                // Note Tweet failed due to authorization. Falling back to standard Tweet.
                const truncateContent = truncateToCompleteSentence(
                    content,
                    this.client.twitterConfig.MAX_TWEET_LENGTH
                );
                return await this.sendStandardTweet(
                    client,
                    truncateContent,
                    tweetId
                );
            } else {
                return noteTweetResult.data.notetweet_create.tweet_results
                    .result;
            }
        } catch (error) {
            throw new Error(`Note Tweet failed: ${error}`);
        }
    }

    async sendStandardTweet(
        client: ClientBase,
        content: string,
        tweetId?: string,
        mediaData?: MediaData[]
    ) {
        try {
            const standardTweetResult = await client.requestQueue.add(
                async () =>
                    await client.twitterClient.sendTweet(
                        content,
                        tweetId,
                        mediaData
                    )
            );
            const body = await standardTweetResult.json();
            if (!body?.data?.create_tweet?.tweet_results?.result) {
                elizaLogger.error("Error sending tweet; Bad response:", body);
                return;
            }
            return body.data.create_tweet.tweet_results.result;
        } catch (error) {
            elizaLogger.error("Error sending standard Tweet:", error);
            throw error;
        }
    }

    createTweetObject(
        tweetResult: any,
        client: any,
        twitterUsername: string
    ): Tweet {
        return {
            id: tweetResult.rest_id,
            name: client.profile.screenName,
            username: client.profile.username,
            text: tweetResult.legacy.full_text,
            conversationId: tweetResult.legacy.conversation_id_str,
            createdAt: tweetResult.legacy.created_at,
            timestamp: new Date(tweetResult.legacy.created_at).getTime(),
            userId: client.profile.id,
            inReplyToStatusId: tweetResult.legacy.in_reply_to_status_id_str,
            permanentUrl: `https://twitter.com/${twitterUsername}/status/${tweetResult.rest_id}`,
            hashtags: [],
            mentions: [],
            photos: [],
            thread: [],
            urls: [],
            videos: [],
        } as Tweet;
    }

    async processAndCacheTweet(
        runtime: IAgentRuntime,
        client: ClientBase,
        tweet: Tweet,
        roomId: UUID,
        rawTweetContent: string
    ) {
        // Cache the last post details
        await runtime.cacheManager.set(
            `twitter/${client.profile.username}/lastPost`,
            {
                id: tweet.id,
                timestamp: Date.now(),
            }
        );

        // Cache the tweet
        await client.cacheTweet(tweet);

        // Log the posted tweet
        elizaLogger.log(`Tweet posted:\n ${tweet.permanentUrl}`);

        // Ensure the room and participant exist
        await runtime.ensureRoomExists(roomId);
        await runtime.ensureParticipantInRoom(runtime.agentId, roomId);

        // Create a memory for the tweet
        await runtime.messageManager.createMemory({
            id: stringToUuid(tweet.id + "-" + runtime.agentId),
            userId: runtime.agentId,
            agentId: runtime.agentId,
            content: {
                text: rawTweetContent.trim(),
                url: tweet.permanentUrl,
                source: "twitter",
            },
            roomId,
            embedding: getEmbeddingZeroVector(),
            createdAt: tweet.timestamp,
        });
    }
}