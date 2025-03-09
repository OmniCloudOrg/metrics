// Updated to use ES modules instead of CommonJS
import { Octokit } from 'octokit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Get current directory with ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const ORG_NAME = process.env.ORGANIZATION || 'OmniCloudOrg';
const TOKEN = process.env.GITHUB_TOKEN;
const OUTPUT_DIR = path.join(process.cwd(), 'data');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'github-metrics.json');
const HISTORY_FILE = path.join(OUTPUT_DIR, 'metrics-history.json');

// Initialize GitHub client with auth token
const octokit = new Octokit({
  auth: TOKEN,
  userAgent: 'GitHub-Metrics-Action',
});

// Language factors for estimating lines of code
const LANGUAGE_FACTORS = {
  'JavaScript': 0.05,  // ~20 bytes per line
  'TypeScript': 0.05,
  'Python': 0.08,      // ~12 bytes per line
  'Java': 0.04,        // ~25 bytes per line
  'C#': 0.04,
  'Go': 0.06,
  'Ruby': 0.07,
  'PHP': 0.05,
  'C++': 0.04,
  'C': 0.05,
  'HTML': 0.02,        // ~50 bytes per line
  'CSS': 0.03,
  'Shell': 0.1,
  'Markdown': 0.1,
  'JSON': 0.01,        // ~100 bytes per line
  'YAML': 0.08,
  // Default factor for other languages
  'default': 0.05
};

// Main function to collect all metrics
async function collectMetrics() {
  console.log(`Starting metrics collection for ${ORG_NAME}...`);
  const startTime = Date.now();
  const metrics = {
    organization: ORG_NAME,
    timestamp: new Date().toISOString(),
    stats: {
      repositories: 0,
      stars: 0,
      forks: 0,
      watchers: 0,
      openIssues: 0,
      totalCommits: 0,
      linesOfCode: 0,
      pullRequests: {
        open: 0,
        closed: 0,
        merged: 0
      },
      contributors: {
        total: 0,
        top: []
      },
      languages: {}
    },
    repositories: []
  };

  try {
    // Create output directory if it doesn't exist
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    // 1. Get all repositories for the organization
    console.log(`Fetching repositories for ${ORG_NAME}...`);
    const repositories = await getAllRepositories();
    console.log(`Found ${repositories.length} repositories`);
    metrics.stats.repositories = repositories.length;

    // 2. Process each repository
    console.log('Processing repositories...');
    for (const repo of repositories) {
      console.log(`Processing ${repo.name}...`);
      
      // Add basic repository stats
      metrics.stats.stars += repo.stargazers_count || 0;
      metrics.stats.forks += repo.forks_count || 0;
      metrics.stats.watchers += repo.watchers_count || 0;
      metrics.stats.openIssues += repo.open_issues_count || 0;

      // Get repository metrics
      const repoMetrics = await getRepositoryMetrics(repo);
      metrics.repositories.push(repoMetrics);
      
      // Update language stats
      for (const [language, bytes] of Object.entries(repoMetrics.languages || {})) {
        if (!metrics.stats.languages[language]) {
          metrics.stats.languages[language] = 0;
        }
        metrics.stats.languages[language] += bytes;
      }
      
      // Update total lines of code
      metrics.stats.linesOfCode += repoMetrics.linesOfCode || 0;
      
      // Update total commits
      metrics.stats.totalCommits += repoMetrics.commits || 0;
      
      // Update PR counts
      metrics.stats.pullRequests.open += repoMetrics.pullRequests?.open || 0;
      metrics.stats.pullRequests.closed += repoMetrics.pullRequests?.closed || 0;
      metrics.stats.pullRequests.merged += repoMetrics.pullRequests?.merged || 0;
    }

    // 3. Get contributor metrics
    console.log('Collecting contributor metrics...');
    const contributorMetrics = await getContributorMetrics(repositories);
    metrics.stats.contributors.total = contributorMetrics.totalContributors;
    metrics.stats.contributors.top = contributorMetrics.topContributors;

    // 4. Save the metrics
    console.log('Saving metrics...');
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(metrics, null, 2));
    
    // 5. Update historical data
    updateHistory(metrics);

    const duration = (Date.now() - startTime) / 1000;
    console.log(`✅ Metrics collection completed in ${duration.toFixed(2)}s`);
    
  } catch (error) {
    console.error('Error collecting metrics:', error);
    process.exit(1);
  }
}

// Get all repositories for the organization
async function getAllRepositories() {
  const repos = [];
  let page = 1;
  let hasMore = true;
  
  while (hasMore) {
    try {
      const { data } = await octokit.rest.repos.listForOrg({
        org: ORG_NAME,
        per_page: 100,
        page: page,
        sort: 'updated',
        direction: 'desc'
      });
      
      repos.push(...data);
      
      hasMore = data.length === 100;
      page++;
      
      // Safety limit
      if (page > 10) {
        console.warn('Reached page limit (10), stopping repository fetch');
        hasMore = false;
      }
      
      // Sleep to avoid rate limits
      if (hasMore) {
        await sleep(500);
      }
    } catch (error) {
      console.error(`Error fetching repos page ${page}:`, error.message);
      hasMore = false;
    }
  }
  
  return repos;
}

// Get metrics for a single repository
async function getRepositoryMetrics(repo) {
  const repoMetrics = {
    name: repo.name,
    description: repo.description,
    url: repo.html_url,
    isPrivate: repo.private,
    isFork: repo.fork,
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    watchers: repo.watchers_count,
    openIssues: repo.open_issues_count,
    createdAt: repo.created_at,
    updatedAt: repo.updated_at,
    pushedAt: repo.pushed_at,
    size: repo.size,
    defaultBranch: repo.default_branch,
    languages: {},
    linesOfCode: 0,
    commits: 0,
    contributors: 0,
    pullRequests: {
      open: 0,
      closed: 0,
      merged: 0
    }
  };
  
  // Get commits count
  try {
    repoMetrics.commits = await getCommitCount(repo.name);
  } catch (error) {
    console.warn(`Error getting commit count for ${repo.name}:`, error.message);
  }
  
  // Get contributors count
  try {
    repoMetrics.contributors = await getContributorCount(repo.name);
  } catch (error) {
    console.warn(`Error getting contributor count for ${repo.name}:`, error.message);
  }
  
  // Get language breakdown
  try {
    repoMetrics.languages = await getLanguages(repo.name);
    repoMetrics.linesOfCode = calculateLinesOfCode(repoMetrics.languages);
  } catch (error) {
    console.warn(`Error getting languages for ${repo.name}:`, error.message);
    // Fallback to size-based estimate
    repoMetrics.linesOfCode = Math.round(repo.size * 0.1);
  }
  
  // Get PR counts
  try {
    repoMetrics.pullRequests = await getPullRequestCounts(repo.name);
  } catch (error) {
    console.warn(`Error getting PR counts for ${repo.name}:`, error.message);
  }
  
  return repoMetrics;
}

// Get commit count for a repository
async function getCommitCount(repo) {
  try {
    // First try with a single commit to get pagination info
    const response = await octokit.rest.repos.listCommits({
      owner: ORG_NAME,
      repo: repo,
      per_page: 1
    });
    
    // Check if there's a link header with last page info
    const linkHeader = response.headers.link;
    if (linkHeader && linkHeader.includes('rel="last"')) {
      const match = linkHeader.match(/page=(\d+)>; rel="last"/);
      if (match) {
        return parseInt(match[1], 10);
      }
    }
    
    // If no link header or no match, try to get all commits
    const { data } = await octokit.rest.repos.listCommits({
      owner: ORG_NAME,
      repo: repo,
      per_page: 100
    });
    
    return data.length;
  } catch (error) {
    if (error.status === 409) {
      // Empty repository
      return 0;
    }
    throw error;
  }
}

// Get contributor count for a repository
async function getContributorCount(repo) {
  try {
    const response = await octokit.rest.repos.listContributors({
      owner: ORG_NAME,
      repo: repo,
      per_page: 1,
      anon: 0
    });
    
    // Check if there's pagination
    const linkHeader = response.headers.link;
    if (linkHeader && linkHeader.includes('rel="last"')) {
      const match = linkHeader.match(/page=(\d+)>; rel="last"/);
      if (match) {
        return parseInt(match[1], 10);
      }
    }
    
    // Otherwise try to count all contributors
    const allContributors = await octokit.rest.repos.listContributors({
      owner: ORG_NAME,
      repo: repo,
      per_page: 100
    });
    
    return allContributors.data.length;
  } catch (error) {
    if (error.status === 409 || error.status === 404) {
      // Empty repository or no contributors
      return 0;
    }
    throw error;
  }
}

// Get language breakdown for a repository
async function getLanguages(repo) {
  try {
    const { data } = await octokit.rest.repos.listLanguages({
      owner: ORG_NAME,
      repo: repo
    });
    
    return data;
  } catch (error) {
    console.warn(`Error getting languages for ${repo}:`, error.message);
    return {};
  }
}

// Calculate lines of code based on language bytes
function calculateLinesOfCode(languages) {
  let totalLines = 0;
  
  for (const [language, bytes] of Object.entries(languages)) {
    const factor = LANGUAGE_FACTORS[language] || LANGUAGE_FACTORS.default;
    totalLines += bytes * factor;
  }
  
  return Math.round(totalLines);
}

// Get pull request counts for a repository
async function getPullRequestCounts(repo) {
  const counts = {
    open: 0,
    closed: 0,
    merged: 0
  };
  
  // Get open PRs
  try {
    const openResponse = await octokit.rest.pulls.list({
      owner: ORG_NAME,
      repo: repo,
      state: 'open',
      per_page: 1
    });
    
    // Check for pagination
    const linkHeader = openResponse.headers.link;
    if (linkHeader && linkHeader.includes('rel="last"')) {
      const match = linkHeader.match(/page=(\d+)>; rel="last"/);
      if (match) {
        counts.open = parseInt(match[1], 10);
      }
    } else {
      counts.open = openResponse.data.length;
    }
  } catch (error) {
    console.warn(`Error getting open PRs for ${repo}:`, error.message);
  }
  
  // Get closed PRs
  try {
    const closedResponse = await octokit.rest.pulls.list({
      owner: ORG_NAME,
      repo: repo,
      state: 'closed',
      per_page: 1
    });
    
    // Check for pagination
    const linkHeader = closedResponse.headers.link;
    if (linkHeader && linkHeader.includes('rel="last"')) {
      const match = linkHeader.match(/page=(\d+)>; rel="last"/);
      if (match) {
        const totalClosed = parseInt(match[1], 10);
        
        // Sample a few closed PRs to estimate merge ratio
        const { data: closedSample } = await octokit.rest.pulls.list({
          owner: ORG_NAME,
          repo: repo,
          state: 'closed',
          per_page: 30 // Sample size
        });
        
        const mergedCount = closedSample.filter(pr => pr.merged_at !== null).length;
        const mergeRatio = mergedCount / closedSample.length || 0;
        
        counts.merged = Math.round(totalClosed * mergeRatio);
        counts.closed = totalClosed - counts.merged;
      }
    } else {
      const mergedCount = closedResponse.data.filter(pr => pr.merged_at !== null).length;
      counts.merged = mergedCount;
      counts.closed = closedResponse.data.length - mergedCount;
    }
  } catch (error) {
    console.warn(`Error getting closed PRs for ${repo}:`, error.message);
  }
  
  return counts;
}

// Get contributor metrics
async function getContributorMetrics(repositories) {
  // Map to track contributors and their stats
  const contributorsMap = new Map();
  
  // Process repositories in batches to avoid rate limits
  const BATCH_SIZE = 3;
  for (let i = 0; i < repositories.length; i += BATCH_SIZE) {
    const batch = repositories.slice(i, Math.min(i + BATCH_SIZE, repositories.length));
    
    await Promise.all(batch.map(async (repo) => {
      if (repo.fork) {
        return; // Skip forks
      }
      
      try {
        // Get contributors for this repo
        const { data: repoContributors } = await octokit.rest.repos.listContributors({
          owner: ORG_NAME,
          repo: repo.name,
          per_page: 100
        });
        
        // Process each contributor
        for (const contributor of repoContributors) {
          if (!contributor.login) continue;
          
          const normalizedLogin = contributor.login.toLowerCase();
          
          if (contributorsMap.has(normalizedLogin)) {
            // Update existing contributor
            const existing = contributorsMap.get(normalizedLogin);
            existing.contributions += contributor.contributions;
            
            if (!existing.repositories.includes(repo.name)) {
              existing.repositories.push(repo.name);
            }
          } else {
            // Add new contributor
            contributorsMap.set(normalizedLogin, {
              login: contributor.login,
              avatar_url: contributor.avatar_url,
              html_url: contributor.html_url,
              contributions: contributor.contributions,
              repositories: [repo.name]
            });
          }
        }
        
        // For each repository, also check recent commits for co-authors
        await findCoAuthors(repo.name, contributorsMap);
        
      } catch (error) {
        console.warn(`Error processing contributors for ${repo.name}:`, error.message);
      }
    }));
    
    // Add a delay between batches
    if (i + BATCH_SIZE < repositories.length) {
      await sleep(1000);
    }
  }
  
  // Convert to array and sort by contributions
  const sortedContributors = Array.from(contributorsMap.values())
    .sort((a, b) => b.contributions - a.contributions);
  
  return {
    totalContributors: sortedContributors.length,
    topContributors: sortedContributors.slice(0, 10) // Get top 10 contributors
  };
}

// Find co-authors in commit messages
async function findCoAuthors(repo, contributorsMap) {
  try {
    // Get recent commits
    const { data: commits } = await octokit.rest.repos.listCommits({
      owner: ORG_NAME,
      repo: repo,
      per_page: 30 // Get more commits to find co-authors
    });
    
    // Process each commit for co-authors
    for (const commit of commits) {
      if (!commit.commit?.message) continue;
      
      // Extract co-authors using regex
      const coAuthorRegex = /co[\-\s]authored[\-\s]by:[\s\n]+([^<\n]+?)[\s\n]*<([^>\n]+)>/gi;
      const matches = [...commit.commit.message.matchAll(coAuthorRegex)];
      
      // Also check alternate format
      const alternateRegex = /co-author:[\s\n]+([^<\n]+?)[\s\n]*<([^>\n]+)>/gi;
      const altMatches = [...commit.commit.message.matchAll(alternateRegex)];
      
      // Combine matches
      const allMatches = [...matches, ...altMatches];
      
      for (const match of allMatches) {
        const name = match[1].trim();
        const email = match[2].trim();
        
        // Try to extract username from email or name
        let username = extractUsername(email, name);
        
        if (username) {
          const normalizedLogin = username.toLowerCase();
          
          // Get GitHub user info if possible
          try {
            const { data: user } = await octokit.rest.users.getByUsername({
              username: username
            });
            
            if (user.login) {
              username = user.login;
            }
          } catch (error) {
            // User not found, continue with extracted username
          }
          
          if (contributorsMap.has(normalizedLogin)) {
            // Update existing contributor
            const existing = contributorsMap.get(normalizedLogin);
            existing.contributions++;
            
            if (!existing.repositories.includes(repo)) {
              existing.repositories.push(repo);
            }
          } else {
            // Add new contributor
            contributorsMap.set(normalizedLogin, {
              login: username,
              avatar_url: `https://github.com/${username}.png`,
              html_url: `https://github.com/${username}`,
              contributions: 1,
              repositories: [repo]
            });
          }
        }
      }
    }
  } catch (error) {
    console.warn(`Error finding co-authors for ${repo}:`, error.message);
  }
}

// Extract username from email and name
function extractUsername(email, name) {
  // Handle GitHub noreply email format: ID+username@users.noreply.github.com
  const githubNoReplyRegex = /^(\d+)\+(.+)@users\.noreply\.github\.com$/i;
  const githubMatch = email.match(githubNoReplyRegex);
  
  if (githubMatch && githubMatch[2]) {
    return githubMatch[2];
  }
  
  // Check other GitHub email formats
  if (email.endsWith('@github.com')) {
    return email.split('@')[0];
  }
  
  if (email.endsWith('@users.github.com')) {
    return email.split('@')[0];
  }
  
  if (email.endsWith('@users.noreply.github.com') && !email.includes('+')) {
    return email.split('@')[0];
  }
  
  // Check if name contains a GitHub username format
  if (name) {
    const usernameInName = name.match(/@([a-zA-Z0-9\-]+)/);
    if (usernameInName && usernameInName[1]) {
      return usernameInName[1];
    }
  }
  
  // Extract username from email
  const emailUsername = email.split('@')[0];
  if (emailUsername && emailUsername.length > 2 && !/^\d+$/.test(emailUsername)) {
    return emailUsername;
  }
  
  // Use cleaned name as fallback
  if (name) {
    return name.toLowerCase().replace(/[^a-z0-9]/g, '');
  }
  
  return null;
}

// Update metrics history
function updateHistory(currentMetrics) {
  let history = [];
  
  // Load existing history if available
  if (fs.existsSync(HISTORY_FILE)) {
    try {
      history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    } catch (error) {
      console.warn('Error reading history file, starting new history:', error.message);
    }
  }
  
  // Create historical entry
  const historicalEntry = {
    timestamp: currentMetrics.timestamp,
    repositories: currentMetrics.stats.repositories,
    stars: currentMetrics.stats.stars,
    forks: currentMetrics.stats.forks,
    contributors: currentMetrics.stats.contributors.total,
    commits: currentMetrics.stats.totalCommits,
    linesOfCode: currentMetrics.stats.linesOfCode
  };
  
  // Add to history
  history.push(historicalEntry);
  
  // Keep only the last 100 entries
  if (history.length > 100) {
    history = history.slice(history.length - 100);
  }
  
  // Save history
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

// Helper function for sleeping
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Run the metrics collection
collectMetrics();
