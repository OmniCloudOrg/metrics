#!/usr/bin/env node
/**
 * GitHub Organization Metrics Collector
 * 
 * This script collects comprehensive metrics about a GitHub organization:
 * - Repository stats (stars, forks, watchers)
 * - Contributor information (including co-authors)
 * - Commit counts
 * - Lines of code (by language)
 * 
 * Usage:
 *   GITHUB_TOKEN=your_token ORGANIZATION=OrgName node collect-metrics.mjs
 */

import { Octokit } from 'octokit';
import * as fs from 'fs';
import * as path from 'path';

// Configuration
const ORG_NAME = process.env.ORGANIZATION || 'OmniCloudOrg';
const TOKEN = process.env.GITHUB_TOKEN;
const OUTPUT_DIR = path.join(process.cwd(), 'data');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'github-metrics.json');
const HISTORY_FILE = path.join(OUTPUT_DIR, 'metrics-history.json');
const DEBUG = process.env.DEBUG === 'true';

// Initialize GitHub client with auth token
const octokit = new Octokit({
  auth: TOKEN,
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
  'default': 0.05
};

/**
 * Fetches all pages of a GitHub API endpoint
 */
async function getAllItems(method, params = {}) {
  const items = [];
  let page = 1;
  let hasNextPage = true;
  const maxPages = params.maxPages || 10; // Default page limit
  
  // Remove custom params before passing to GitHub API
  const apiParams = {...params};
  delete apiParams.maxPages;

  while (hasNextPage) {
    try {
      const response = await method({
        ...apiParams,
        page,
        per_page: params.per_page || 100
      });

      const data = response.data;
      items.push(...data);

      // Check if there are more pages
      hasNextPage = data.length === (params.per_page || 100);
      page++;

      // Safety limit to prevent infinite loops
      if (page > maxPages) {
        console.warn(`Reached pagination limit (${maxPages} pages), some data may be incomplete`);
        break;
      }

      // Add a small delay to avoid hitting rate limits
      if (hasNextPage) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch (error) {
      console.error(`Error fetching page ${page}:`, error.message);
      break;
    }
  }

  return items;
}

/**
 * Extract co-authors from commit messages
 */
function extractCoAuthors(message) {
  if (!message) return [];

  // Enable debug mode for diagnostic output
  const debug = process.env.DEBUG_COAUTHORS === 'true';
  
  if (debug) {
    console.log("Analyzing commit message:", message);
  }

  const coauthors = [];
  
  // STEP 1: Split and process approach - handles both single line and multiline formats
  // This is the most reliable method for both formats
  if (message.includes("Co-Authored-By:") || message.includes("Co-authored-by:") || 
      message.includes("co-authored-by:") || message.includes("CO-AUTHORED-BY:")) {
    
    if (debug) console.log("Found Co-Authored-By format");
    
    // First, normalize newlines
    const normalizedMessage = message.replace(/\r\n/g, '\n');
    
    // Split the commit message into lines
    const lines = normalizedMessage.split('\n');
    
    // Iterate through each line
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      if (debug && line.toLowerCase().includes("co-authored-by")) {
        console.log("Processing line:", line);
      }
      
      // Check if this line has "Co-Authored-By:" or variations
      if (/Co-[aA]uthored-[bB]y:/i.test(line)) {
        // Extract the email
        const emailMatch = line.match(/<([^>]+)>/);
        if (emailMatch && emailMatch[1]) {
          const email = emailMatch[1].trim();
          
          // Extract the name: everything before the email bracket
          const nameMatch = line.match(/Co-[aA]uthored-[bB]y:([^<]+)</i);
          const name = nameMatch ? nameMatch[1].trim() : "";
          
          if (debug) console.log("Found co-author:", name, email);
          
          coauthors.push({ name, email });
        }
      }
    }
  }
  
  // STEP 2: Handle the case where multiple co-authors are on a single line
  // This helps when co-authors are not separated by newlines
  const multiCoAuthorPattern = /Co-[aA]uthored-[bB]y:[^<]*<([^>]+)>/g;
  let match;
  
  if (debug) console.log("Checking for multiple co-authors on a single line");
  
  while ((match = multiCoAuthorPattern.exec(message)) !== null) {
    // Get the position where this match ends
    const matchEnd = multiCoAuthorPattern.lastIndex;
    
    // Get the entire matched substring
    const fullMatch = message.substring(match.index, matchEnd);
    
    // Extract the email
    const email = match[1].trim();
    
    // Extract the name: everything between "Co-Authored-By:" and "<email>"
    const nameMatch = fullMatch.match(/Co-[aA]uthored-[bB]y:([^<]+)</i);
    const name = nameMatch ? nameMatch[1].trim() : "";
    
    if (debug) console.log("Found co-author in single line:", name, email);
    
    coauthors.push({ name, email });
  }
  
  // STEP 3: Also try the traditional regex patterns for other formats
  const patterns = [
    // Standard GitHub format (case insensitive)
    /co[\-\s]authored[\-\s]by:[\s\n]+([^<\n]+?)[\s\n]*<([^>\n]+)>/gi,
    // Alternate format
    /co-author:[\s\n]+([^<\n]+?)[\s\n]*<([^>\n]+)>/gi,
    // Format with no spaces
    /coauthored[\-\s]?by:[\s\n]+([^<\n]+?)[\s\n]*<([^>\n]+)>/gi,
    // Potential typos or variations
    /co[\-\s]?auth?ored[\-\s]?by:[\s\n]+([^<\n]+?)[\s\n]*<([^>\n]+)>/gi,
    // Handle format with just email
    /co[\-\s]authored[\-\s]by:[\s\n]*<([^>\n]+)>/gi,
    // Credits format (less common)
    /credits:[\s\n]+([^<\n]+?)[\s\n]*<([^>\n]+)>/gi,
    // with format
    /with:[\s\n]+([^<\n]+?)[\s\n]*<([^>\n]+)>/gi,
    // Signed-off-by format (often used in Git commits)
    /signed[\-\s]off[\-\s]by:[\s\n]+([^<\n]+?)[\s\n]*<([^>\n]+)>/gi,
    // Author format
    /author:[\s\n]+([^<\n]+?)[\s\n]*<([^>\n]+)>/gi
  ];
  
  if (debug) console.log("Trying traditional regex patterns");
  
  for (const pattern of patterns) {
    const matches = [...message.matchAll(pattern)];
    for (const match of matches) {
      // Check if we have name and email or just email
      if (match.length > 2) {
        const name = match[1].trim();
        const email = match[2].trim();
        
        if (debug) console.log("Found co-author from pattern:", name, email);
        
        coauthors.push({
          name,
          email
        });
      } else if (match.length > 1) {
        // Just email format
        const email = match[1].trim();
        
        if (debug) console.log("Found co-author email-only:", email);
        
        coauthors.push({
          name: "",
          email
        });
      }
    }
  }
  
  // STEP 4: Special case for GitHub username mentions
  const usernamePattern = /@([a-zA-Z0-9\-]+)/g;
  const usernameMatches = [...message.matchAll(usernamePattern)];
  
  if (debug) console.log("Checking for GitHub username mentions");
  
  for (const match of usernameMatches) {
    if (match[1] && match[1].length > 2) {
      const username = match[1];
      
      if (debug) console.log("Found GitHub username mention:", username);
      
      coauthors.push({
        name: username,
        email: `${username}@users.noreply.github.com`
      });
    }
  }
  
  // STEP 5: Look for any email addresses in the commit message as fallback
  const emailPattern = /\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/g;
  const emailMatches = [...message.matchAll(emailPattern)];
  
  if (debug) console.log("Checking for general email addresses");
  
  for (const match of emailMatches) {
    if (match[1]) {
      const email = match[1];
      
      if (debug) console.log("Found email address:", email);
      
      coauthors.push({
        name: "",
        email
      });
    }
  }
  
  // STEP 6: Finally, try a desperate approach for multi-line multi-author format
  // This is specifically for your format example
  const lines = message.split('\n');
  const joinedMessage = lines.join(' ');
  const complexPattern = /Co-Authored-By:[^<]+<[^>]+>/gi;
  const complexMatches = [...joinedMessage.matchAll(complexPattern)];
  
  if (debug) console.log(`Trying desperate approach, found ${complexMatches.length} matches`);
  
  for (const complexMatch of complexMatches) {
    const matchText = complexMatch[0];
    const emailMatch = matchText.match(/<([^>]+)>/);
    if (emailMatch && emailMatch[1]) {
      const email = emailMatch[1].trim();
      const nameMatch = matchText.match(/Co-Authored-By:([^<]+)</i);
      const name = nameMatch ? nameMatch[1].trim() : "";
      
      if (debug) console.log("Found co-author from complex pattern:", name, email);
      
      coauthors.push({ name, email });
    }
  }
  
  // STEP 7: Remove duplicates based on email
  const uniqueEmails = new Set();
  const uniqueCoauthors = coauthors.filter(author => {
    if (!author.email || uniqueEmails.has(author.email.toLowerCase())) {
      return false;
    }
    uniqueEmails.add(author.email.toLowerCase());
    return true;
  });
  
  if (debug) {
    console.log(`Found ${coauthors.length} co-authors, ${uniqueCoauthors.length} unique`);
    console.log("Final co-authors list:", uniqueCoauthors);
  }
  
  return uniqueCoauthors;
}

/**
 * Extract username from GitHub email or name
 */
function getUsernameFromEmail(email, name) {
  if (!email && !name) return null;
  
  // Clean the inputs
  email = email || '';
  name = name || '';
  
  // Try to extract from clear GitHub username mentions
  if (name.includes('@')) {
    const usernameMatch = name.match(/@([a-zA-Z0-9\-]+)/);
    if (usernameMatch && usernameMatch[1]) {
      return usernameMatch[1];
    }
  }
  
  // Handle GitHub noreply email format: ID+username@users.noreply.github.com
  const githubNoReplyRegex = /^(\d+)\+(.+)@users\.noreply\.github\.com$/i;
  const githubMatch = email.match(githubNoReplyRegex);
  
  if (githubMatch && githubMatch[2]) {
    return githubMatch[2];
  }
  
  // Check for typical GitHub team member format
  if (email.includes('+')) {
    const parts = email.split('+');
    if (parts.length > 1 && parts[1].includes('@')) {
      const username = parts[1].split('@')[0];
      if (username && username.length > 2) {
        return username;
      }
    }
  }
  
  // Check other GitHub email formats
  if (email.endsWith('@github.com')) {
    return email.split('@')[0];
  }
  
  if (email.endsWith('@users.github.com') || 
      (email.endsWith('@users.noreply.github.com') && !email.includes('+'))) {
    return email.split('@')[0];
  }
  
  // Look for GitHub username in name (without @ symbol)
  if (name) {
    // Check if name looks like a GitHub username
    if (/^[a-zA-Z0-9\-]+$/.test(name) && name.length > 2 && name.length < 40) {
      return name;
    }
    
    // Try to extract a GitHub username from the name
    // Often names are formatted as "Real Name (username)"
    const parenthesesMatch = name.match(/\(([a-zA-Z0-9\-]+)\)/);
    if (parenthesesMatch && parenthesesMatch[1]) {
      return parenthesesMatch[1];
    }
  }
  
  // Extract username from email
  const emailUsername = email.split('@')[0];
  if (emailUsername && emailUsername.length > 2 && !/^\d+$/.test(emailUsername)) {
    return emailUsername;
  }
  
  // Use cleaned name as fallback
  if (name) {
    // Try to get just the first word of the name as username
    const firstWord = name.split(/\s+/)[0];
    if (firstWord && firstWord.length > 2) {
      return firstWord.toLowerCase().replace(/[^a-z0-9]/g, '');
    }
    
    return name.toLowerCase().replace(/[^a-z0-9]/g, '');
  }
  
  // Last resort: use a placeholder with email hash
  if (email) {
    const hash = email.split('').reduce((a, b) => (((a << 5) - a) + b.charCodeAt(0))|0, 0);
    return `contributor-${Math.abs(hash)}`;
  }
  
  return null;
}

/**
 * Main function to collect all GitHub metrics
 */
async function collectMetrics() {
  console.log(`Starting metrics collection for ${ORG_NAME}...`);
  const startTime = Date.now();
  
  try {
    // Create output directory if it doesn't exist
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    // Get all repositories
    console.log(`Fetching repositories for ${ORG_NAME}...`);
    const allRepos = await getAllItems(
      octokit.rest.repos.listForOrg,
      { org: ORG_NAME, sort: 'updated', direction: 'desc' }
    );
    
    console.log(`Found ${allRepos.length} repositories`);
    
    // Initialize metrics object
    const metrics = {
      organization: ORG_NAME,
      timestamp: new Date().toISOString(),
      stats: {
        repositories: allRepos.length,
        stars: 0,
        forks: 0,
        watchers: 0,
        openIssues: 0,
        totalCommits: 0,
        linesOfCode: 0,
        contributors: {
          total: 0,
          top: []
        },
        languages: {}
      },
      repositories: []
    };
    
    // Track contributors across all repos
    const contributorsMap = new Map();
    
    // Process repositories
    console.log('Processing repositories...');
    const MAX_BATCH_SIZE = 3; // Process repos in batches to avoid rate limits
    
    // First process the most important repos - the main repo and recently updated ones
    const primaryRepos = allRepos.filter(repo => 
      repo.name === 'OmniCloud-Full' || // Main repo (adjust name if needed)
      repo.pushed_at && new Date(repo.pushed_at) > new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // Recently updated
    );
    
    console.log(`Processing ${primaryRepos.length} primary/recent repositories first...`);
    
    // Split into primary repos and remaining repos
    const remainingRepos = allRepos.filter(repo => 
      !primaryRepos.some(p => p.name === repo.name)
    );
    
    // Process repos in order: primary first, then others
    const allReposInProcessOrder = [...primaryRepos, ...remainingRepos];
    
    for (let i = 0; i < allReposInProcessOrder.length; i += MAX_BATCH_SIZE) {
      const batch = allReposInProcessOrder.slice(i, i + MAX_BATCH_SIZE);
      
      await Promise.all(batch.map(async (repo) => {
        console.log(`Processing ${repo.name}...`);
        
        // Add basic stats to totals
        metrics.stats.stars += repo.stargazers_count || 0;
        metrics.stats.forks += repo.forks_count || 0;
        metrics.stats.watchers += repo.watchers_count || 0;
        metrics.stats.openIssues += repo.open_issues_count || 0;
        
        const repoMetrics = {
          name: repo.name,
          description: repo.description,
          url: repo.html_url,
          stars: repo.stargazers_count || 0,
          forks: repo.forks_count || 0,
          watchers: repo.watchers_count || 0,
          openIssues: repo.open_issues_count || 0,
          languages: {},
          linesOfCode: 0,
          commits: 0,
          contributors: 0
        };
        
        try {
          // Get language breakdown
          const languages = await octokit.rest.repos.listLanguages({
            owner: ORG_NAME,
            repo: repo.name
          });
          
          repoMetrics.languages = languages.data;
          
          // Calculate lines of code
          let repoLines = 0;
          for (const [language, bytes] of Object.entries(languages.data)) {
            const factor = LANGUAGE_FACTORS[language] || LANGUAGE_FACTORS.default;
            const lines = Math.round(bytes * factor);
            repoLines += lines;
            
            // Add to global language stats
            if (!metrics.stats.languages[language]) {
              metrics.stats.languages[language] = 0;
            }
            metrics.stats.languages[language] += bytes;
          }
          
          repoMetrics.linesOfCode = repoLines;
          metrics.stats.linesOfCode += repoLines;
          
          // Get number of commits
          const commitsResponse = await octokit.rest.repos.listCommits({
            owner: ORG_NAME,
            repo: repo.name,
            per_page: 1
          });
          
          // If there's a Link header with last page, use it to get total count
          const linkHeader = commitsResponse.headers.link;
          if (linkHeader && linkHeader.includes('rel="last"')) {
            const match = linkHeader.match(/page=(\d+)>; rel="last"/);
            if (match) {
              const totalCommits = parseInt(match[1], 10);
              repoMetrics.commits = totalCommits;
              metrics.stats.totalCommits += totalCommits;
            }
          } else {
            // For primary repositories, look at more commits
            const isMainRepo = repo.name === 'OmniCloud-Full'; // Adjust name if needed
            const commitLimit = isMainRepo ? 500 : 100;
            
            console.log(`  Fetching up to ${commitLimit} commits for ${repo.name}...`);
            const allCommits = await getAllItems(
              octokit.rest.repos.listCommits,
              { 
                owner: ORG_NAME, 
                repo: repo.name,
                per_page: 100, // GitHub max per page
                // Use a larger limit only for primary repos
                maxPages: isMainRepo ? 5 : 1 
              }
            );
            repoMetrics.commits = allCommits.length;
            metrics.stats.totalCommits += allCommits.length;
            
            // Process commits for co-authors
            console.log(`  Checking ${allCommits.length} commits for co-authors...`);
            let coAuthorCount = 0;
            for (const commit of allCommits) {
              if (!commit.commit?.message) continue;
              
              // Process commit authors
              if (commit.author && commit.author.login) {
                const authorLogin = commit.author.login.toLowerCase();
                if (!contributorsMap.has(authorLogin)) {
                  contributorsMap.set(authorLogin, {
                    login: commit.author.login,
                    avatar_url: commit.author.avatar_url,
                    html_url: commit.author.html_url,
                    contributions: 0,
                    lines_contributed: 0,
                    repositories: new Set()
                  });
                }
                
                const contributor = contributorsMap.get(authorLogin);
                contributor.contributions += 1;
                contributor.repositories.add(repo.name);
              }
              
              // Process co-authors in commit message
              const coAuthors = extractCoAuthors(commit.commit.message);
              for (const { name, email } of coAuthors) {
                coAuthorCount++;
                const username = getUsernameFromEmail(email, name);
                if (!username) continue;
                
                const normalizedUsername = username.toLowerCase();
                if (!contributorsMap.has(normalizedUsername)) {
                  contributorsMap.set(normalizedUsername, {
                    login: username,
                    avatar_url: `https://github.com/${username}.png`,
                    html_url: `https://github.com/${username}`,
                    contributions: 0,
                    lines_contributed: 0,
                    repositories: new Set()
                  });
                }
                
                const contributor = contributorsMap.get(normalizedUsername);
                contributor.contributions += 1;
                contributor.repositories.add(repo.name);
              }
            }
            
            console.log(`  Found ${coAuthorCount} co-author mentions in ${repo.name}`);
          }
          
          // Get contributors count
          const contributors = await getAllItems(
            octokit.rest.repos.listContributors,
            { owner: ORG_NAME, repo: repo.name }
          );
          
          repoMetrics.contributors = contributors.length;
          
          // Process each contributor
          for (const contributor of contributors) {
            if (!contributor.login) continue;
            
            const normalizedLogin = contributor.login.toLowerCase();
            if (!contributorsMap.has(normalizedLogin)) {
              contributorsMap.set(normalizedLogin, {
                login: contributor.login,
                avatar_url: contributor.avatar_url,
                html_url: contributor.html_url,
                contributions: 0,
                lines_contributed: 0,
                repositories: new Set()
              });
            }
            
            const existingContributor = contributorsMap.get(normalizedLogin);
            existingContributor.contributions += contributor.contributions;
            existingContributor.repositories.add(repo.name);
            
            // Estimate lines contributed based on proportion of commits
            const contributionRatio = contributor.contributions / Math.max(repoMetrics.commits, 1);
            const estimatedLines = Math.round(repoLines * contributionRatio);
            existingContributor.lines_contributed += estimatedLines;
          }
          
        } catch (error) {
          console.error(`  Error processing ${repo.name}:`, error.message);
        }
        
        metrics.repositories.push(repoMetrics);
      }));
      
      // Add small delay between batches
      if (i + MAX_BATCH_SIZE < allReposInProcessOrder.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    // Convert contributors map to array and sort by contributions
    const allContributors = Array.from(contributorsMap.values())
      .map(c => ({
        ...c,
        repositories: Array.from(c.repositories)
      }))
      .sort((a, b) => b.contributions - a.contributions);
    
    metrics.stats.contributors.total = allContributors.length;
    metrics.stats.contributors.top = allContributors.slice(0, 10);
    
    console.log(`Found ${allContributors.length} unique contributors`);
    console.log(`Total commits: ${metrics.stats.totalCommits}`);
    console.log(`Total lines of code: ${metrics.stats.linesOfCode}`);
    
    // Save metrics to file
    console.log(`Saving metrics to ${OUTPUT_FILE}...`);
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(metrics, null, 2));
    
    // Update history
    let history = [];
    if (fs.existsSync(HISTORY_FILE)) {
      try {
        history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      } catch (error) {
        console.warn('Error reading history file, starting fresh:', error.message);
      }
    }
    
    history.push({
      timestamp: metrics.timestamp,
      repositories: metrics.stats.repositories,
      stars: metrics.stats.stars,
      forks: metrics.stats.forks,
      contributors: metrics.stats.contributors.total,
      commits: metrics.stats.totalCommits,
      linesOfCode: metrics.stats.linesOfCode
    });
    
    // Keep history to reasonable size
    if (history.length > 100) {
      history = history.slice(-100);
    }
    
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
    console.log(`Updated metrics history in ${HISTORY_FILE}`);
    
    const duration = (Date.now() - startTime) / 1000;
    console.log(`✅ Metrics collection completed in ${duration.toFixed(2)}s`);
    
  } catch (error) {
    console.error('Error collecting metrics:', error);
    process.exit(1);
  }
}

// Run the metrics collection
collectMetrics();
