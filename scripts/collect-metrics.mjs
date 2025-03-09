#!/usr/bin/env node
/**
 * GitHub Organization Metrics Collector (Enhanced Version)
 * 
 * This enhanced version includes GitHub user lookup for co-authors by email
 * and improved deduplication of contributors
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
const DEBUG = true; // Always enable debug for debugging version

// Initialize GitHub client with auth token
const octokit = new Octokit({
  auth: TOKEN,
});

// Rate limit tracking
let remainingRequests = 5000; // Default GitHub API rate limit
let resetTime = null;
let totalRequests = 0;

/**
 * Wrapper for GitHub API requests with detailed logging
 */
async function apiRequest(method, params = {}) {
  try {
    totalRequests++;
    console.log(`[API Request #${totalRequests}] ${method.name} ${JSON.stringify(params)}`);
    
    const response = await method(params);
    
    // Track rate limits
    const headers = response.headers;
    if (headers && headers['x-ratelimit-remaining']) {
      remainingRequests = parseInt(headers['x-ratelimit-remaining'], 10);
      resetTime = new Date(parseInt(headers['x-ratelimit-reset'], 10) * 1000);
      
      console.log(`[Rate Limit] ${remainingRequests} requests remaining, resets at ${resetTime.toLocaleTimeString()}`);
      
      if (remainingRequests < 20) {
        console.warn(`⚠️ WARNING: Rate limit running low (${remainingRequests} requests remaining)`);
      }
    }
    
    return response;
  } catch (error) {
    console.error(`[API Error] ${method.name} ${JSON.stringify(params)}: ${error.message}`);
    if (error.response) {
      console.error(`Status: ${error.response.status} ${error.response.data?.message || ''}`);
    }
    throw error;
  }
}

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

  while (hasNextPage && remainingRequests > 5) {
    try {
      const response = await apiRequest(method, {
        ...apiParams,
        page,
        per_page: params.per_page || 100
      });

      const data = response.data;
      console.log(`[Page ${page}] Retrieved ${data.length} items`);
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
function extractCoAuthors(message, repoName) {
  if (!message) return [];

  console.log(`[${repoName}] Analyzing commit message`);
  
  const coauthors = [];
  
  // STEP 1: Split and process approach - handles both single line and multiline formats
  if (message.includes("Co-Authored-By:") || message.includes("Co-authored-by:") || 
      message.includes("co-authored-by:") || message.includes("CO-AUTHORED-BY:")) {
    
    console.log(`[${repoName}] Found Co-Authored-By format`);
    
    // First, normalize newlines
    const normalizedMessage = message.replace(/\r\n/g, '\n');
    
    // Split the commit message into lines
    const lines = normalizedMessage.split('\n');
    
    // Iterate through each line
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      if (line.toLowerCase().includes("co-authored-by")) {
        console.log(`[${repoName}] Processing line: ${line}`);
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
          
          console.log(`[${repoName}] Found co-author: ${name} <${email}>`);
          
          coauthors.push({ name, email, source: 'step1' });
        }
      }
    }
  }
  
  // Special case for the specific format you provided
  // Example: "Co-Authored-By: Name1 <email1> Co-Authored-By: Name2 <email2>"
  if (message.includes("Co-Authored-By:")) {
    const rawMessage = message.replace(/\r\n/g, ' ').replace(/\n/g, ' ');
    
    // Find all occurrences of "Co-Authored-By:" 
    const positions = [];
    let pos = rawMessage.indexOf("Co-Authored-By:");
    while (pos !== -1) {
      positions.push(pos);
      pos = rawMessage.indexOf("Co-Authored-By:", pos + 1);
    }
    
    console.log(`[${repoName}] Found ${positions.length} Co-Authored-By markers`);
    
    // Process each occurrence
    for (let i = 0; i < positions.length; i++) {
      const startPos = positions[i];
      const endPos = i < positions.length - 1 ? positions[i+1] : rawMessage.length;
      
      const section = rawMessage.substring(startPos, endPos);
      console.log(`[${repoName}] Processing section: ${section}`);
      
      // Extract email and name
      const emailMatch = section.match(/<([^>]+)>/);
      if (emailMatch && emailMatch[1]) {
        const email = emailMatch[1].trim();
        
        // Extract name
        const nameMatch = section.match(/Co-Authored-By:\s*([^<]+)</i);
        const name = nameMatch ? nameMatch[1].trim() : "";
        
        console.log(`[${repoName}] Found co-author from section: ${name} <${email}>`);
        
        coauthors.push({ name, email, source: 'step2' });
      }
    }
  }
  
  // STEP 3: Also try the traditional regex patterns for other formats
  const patterns = [
    // Standard GitHub format (case insensitive)
    /co[\-\s]authored[\-\s]by:[\s\n]+([^<\n]+?)[\s\n]*<([^>\n]+)>/gi,
    // Alternate format
    /co-author:[\s\n]+([^<\n]+?)[\s\n]*<([^>\n]+)>/gi
  ];
  
  for (const pattern of patterns) {
    const matches = [...message.matchAll(pattern)];
    for (const match of matches) {
      // Check if we have name and email or just email
      if (match.length > 2) {
        const name = match[1].trim();
        const email = match[2].trim();
        
        console.log(`[${repoName}] Found co-author from pattern: ${name} <${email}>`);
        
        coauthors.push({
          name,
          email,
          source: 'step3'
        });
      }
    }
  }
  
  // STEP 4: Look for any email addresses in the message
  const emailPattern = /\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/g;
  const emailMatches = [...message.matchAll(emailPattern)];
  
  for (const match of emailMatches) {
    if (match[1]) {
      const email = match[1];
      console.log(`[${repoName}] Found email address: ${email}`);
      coauthors.push({
        name: "",
        email,
        source: 'step4'
      });
    }
  }
  
  // Desperate approach for your specific format
  const rawContent = message.replace(/\r\n/g, ' ').replace(/\n/g, ' ');
  if (rawContent.includes("Co-Authored-By:")) {
    console.log(`[${repoName}] Trying desperate approach for specific format`);
    
    // Split by Co-Authored-By: and process each part
    const parts = rawContent.split(/Co-Authored-By:/i);
    parts.shift(); // Remove first part (before first Co-Authored-By)
    
    console.log(`[${repoName}] Found ${parts.length} parts after splitting`);
    
    for (const part of parts) {
      const emailMatch = part.match(/<([^>]+)>/);
      if (emailMatch && emailMatch[1]) {
        const email = emailMatch[1].trim();
        
        // Get name: everything before the email bracket
        const nameMatch = part.match(/^(.*?)</);
        const name = nameMatch ? nameMatch[1].trim() : "";
        
        console.log(`[${repoName}] Found co-author from desperate approach: ${name} <${email}>`);
        
        coauthors.push({ 
          name, 
          email,
          source: 'desperate' 
        });
      }
    }
  }
  
  // Remove duplicates based on email
  const uniqueEmails = new Set();
  const uniqueCoauthors = coauthors.filter(author => {
    if (!author.email || uniqueEmails.has(author.email.toLowerCase())) {
      return false;
    }
    uniqueEmails.add(author.email.toLowerCase());
    return true;
  });
  
  console.log(`[${repoName}] Found ${coauthors.length} co-authors, ${uniqueCoauthors.length} unique`);
  
  return uniqueCoauthors;
}

/**
 * Function to look up GitHub user by email
 * This will help deduplicate contributors and retrieve better profile pictures
 */
async function lookupUserByEmail(email) {
  if (!email) return null;
  
  try {
    console.log(`[Email Lookup] Attempting to find GitHub user for email: ${email}`);
    
    // Use the search API to find users by email
    const searchResponse = await apiRequest(octokit.rest.search.users, {
      q: `${email} in:email`
    });
    
    if (searchResponse.data.items && searchResponse.data.items.length > 0) {
      const user = searchResponse.data.items[0];
      console.log(`[Email Lookup] Found GitHub user: ${user.login} for email: ${email}`);
      
      // Get additional user details
      const userDetails = await apiRequest(octokit.rest.users.getByUsername, {
        username: user.login
      });
      
      return {
        login: user.login,
        avatar_url: user.avatar_url,
        html_url: user.html_url,
        name: userDetails.data.name || user.login,
        found_by_email: true
      };
    }
    
    console.log(`[Email Lookup] No GitHub user found for email: ${email}`);
    return null;
  } catch (error) {
    console.warn(`[Email Lookup] Error looking up user by email ${email}:`, error.message);
    return null;
  }
}

/**
 * Function to lookup users in a batch to avoid rate limits
 */
async function batchLookupUsersByEmail(emails) {
  const results = new Map();
  const uniqueEmails = [...new Set(emails)];
  
  console.log(`[Batch Email Lookup] Processing ${uniqueEmails.length} unique emails`);
  
  // Process in small batches to avoid hitting rate limits
  const BATCH_SIZE = 5;
  for (let i = 0; i < uniqueEmails.length; i += BATCH_SIZE) {
    const batch = uniqueEmails.slice(i, i + BATCH_SIZE);
    console.log(`[Batch Email Lookup] Processing batch ${Math.floor(i/BATCH_SIZE) + 1} of ${Math.ceil(uniqueEmails.length/BATCH_SIZE)}`);
    
    // Process each email in the batch with some delay between requests
    for (const email of batch) {
      if (!results.has(email)) {
        const user = await lookupUserByEmail(email);
        if (user) {
          results.set(email, user);
        }
        
        // Small delay between requests
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    // Larger delay between batches
    if (i + BATCH_SIZE < uniqueEmails.length) {
      console.log(`[Batch Email Lookup] Pausing between batches to avoid rate limits`);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
  
  console.log(`[Batch Email Lookup] Found ${results.size} GitHub users from ${uniqueEmails.length} emails`);
  return results;
}

/**
 * Main function to collect all GitHub metrics
 */
async function collectMetrics() {
  console.log(`Starting metrics collection for ${ORG_NAME}...`);
  console.log(`Using GitHub token: ${TOKEN ? 'Provided' : 'Not provided'}`);
  const startTime = Date.now();
  
  try {
    // Create output directory if it doesn't exist
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    // Check rate limit before we start
    try {
      const rateLimit = await apiRequest(octokit.rest.rateLimit.get);
      console.log(`Rate limit: ${rateLimit.data.resources.core.remaining}/${rateLimit.data.resources.core.limit} requests remaining`);
      console.log(`Rate limit resets at: ${new Date(rateLimit.data.resources.core.reset * 1000).toLocaleTimeString()}`);
      
      remainingRequests = rateLimit.data.resources.core.remaining;
      resetTime = new Date(rateLimit.data.resources.core.reset * 1000);
    } catch (error) {
      console.warn("Could not check rate limit:", error.message);
    }

    // Get all repositories
    console.log(`Fetching repositories for ${ORG_NAME}...`);
    const allRepos = await getAllItems(
      octokit.rest.repos.listForOrg,
      { org: ORG_NAME, sort: 'updated', direction: 'desc' }
    );
    
    console.log(`Found ${allRepos.length} repositories`);
    
    // Log repository details
    allRepos.forEach((repo, i) => {
      console.log(`Repo ${i+1}: ${repo.name} (${repo.fork ? 'Fork' : 'Source'}, ${repo.stargazers_count} stars)`);
    });
    
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
    
    // Track all co-author emails to look up GitHub users later
    const coAuthorEmails = new Set();
    
    // Create a file to store all co-authors we find for debugging
    const coauthorLogPath = path.join(process.cwd(), 'coauthor-debug.json');
    const allCoauthors = [];
    
    // Process repositories
    console.log('Processing repositories...');
    const MAX_BATCH_SIZE = 1; // Process 1 repo at a time for clearer debugging
    
    // First process the most important repos - the main repo and recently updated ones
    const primaryRepos = allRepos.filter(repo => 
      repo.name === 'OmniCloud-Full' || // Main repo (adjust name if needed)
      (repo.pushed_at && new Date(repo.pushed_at) > new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)) // Recently updated
    );
    
    console.log(`Processing ${primaryRepos.length} primary/recent repositories first...`);
    
    // Split into primary repos and remaining repos
    const remainingRepos = allRepos.filter(repo => 
      !primaryRepos.some(p => p.name === repo.name)
    );
    
    // Process repos in order: primary first, then others
    const allReposInProcessOrder = [...primaryRepos, ...remainingRepos];
    
    // Track repo stats
    const repoStats = {
      total: allReposInProcessOrder.length,
      processed: 0,
      withContributors: 0,
      withCoAuthors: 0
    };
    
    console.log("Processing metrics...");
    
    for (let i = 0; i < allReposInProcessOrder.length; i += MAX_BATCH_SIZE) {
      const batch = allReposInProcessOrder.slice(i, i + MAX_BATCH_SIZE);
      
      for (const repo of batch) {
        console.log(`Processing ${repo.name}...`);
        repoStats.processed++;
        
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
          // Get contributors first
          console.log(`Fetching contributors for ${repo.name}...`);
          const contributors = await getAllItems(
            octokit.rest.repos.listContributors,
            { owner: ORG_NAME, repo: repo.name, anon: 0 }
          );
          
          console.log(`Found ${contributors.length} direct contributors in ${repo.name}`);
          repoMetrics.contributors = contributors.length;
          
          if (contributors.length > 0) {
            repoStats.withContributors++;
          }
          
          // Process each contributor
          for (const contributor of contributors) {
            if (!contributor.login) {
              console.log(`Skipping contributor without login in ${repo.name}`);
              continue;
            }
            
            const normalizedLogin = contributor.login.toLowerCase();
            console.log(`Processing contributor: ${contributor.login} (${contributor.contributions} contributions)`);
            
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
            
            console.log(`Updated ${contributor.login}: now ${existingContributor.contributions} contributions total`);
          }
          
          // Get commit count and find co-authors
          console.log(`Fetching commits for ${repo.name}...`);
          
          // First try to get count from pagination headers
          try {
            const commitsResponse = await apiRequest(octokit.rest.repos.listCommits, {
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
                
                console.log(`${repo.name} has ${totalCommits} commits (from pagination)`);
              }
            }
          } catch (error) {
            console.warn(`Couldn't get commit count from pagination for ${repo.name}:`, error.message);
          }
          
          // Now fetch actual commits to find co-authors
          const isMainRepo = repo.name === 'OmniCloud-Full'; // Adjust name if needed
          const commitLimit = isMainRepo ? 500 : 100;
          
          console.log(`Fetching up to ${commitLimit} commits for ${repo.name} to find co-authors...`);
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
          
          if (!repoMetrics.commits) {
            repoMetrics.commits = allCommits.length;
            metrics.stats.totalCommits += allCommits.length;
          }
          
          console.log(`Retrieved ${allCommits.length} commits from ${repo.name}`);
          
          // Process commits for co-authors
          console.log(`Checking ${allCommits.length} commits for co-authors...`);
          let coAuthorCount = 0;
          let commitsWithCoAuthors = 0;
          
          for (const commit of allCommits) {
            if (!commit.commit?.message) {
              console.log(`Skipping commit without message in ${repo.name}`);
              continue;
            }
            
            // Process commit authors (direct contributors)
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
                
                console.log(`Added new contributor from commit: ${commit.author.login}`);
              }
              
              const contributor = contributorsMap.get(authorLogin);
              contributor.contributions += 1;
              contributor.repositories.add(repo.name);
            }
            
            // Process co-authors in commit message
            if (commit.commit.message.includes("Co-")) {
              console.log(`Potential co-author commit: ${commit.sha.substring(0, 7)}`);
              console.log(`Message: ${commit.commit.message}`);
            }
            
            const coAuthors = extractCoAuthors(commit.commit.message, repo.name);
            
            if (coAuthors.length > 0) {
              commitsWithCoAuthors++;
              console.log(`Found ${coAuthors.length} co-authors in commit ${commit.sha.substring(0, 7)}`);
              
              // Save for debugging
              allCoauthors.push({
                repo: repo.name,
                sha: commit.sha,
                message: commit.commit.message,
                coAuthors: coAuthors
              });
            }
            
            for (const { name, email, source } of coAuthors) {
              coAuthorCount++;
              console.log(`Co-author: ${name} <${email}> (from ${source})`);
              
              // Collect email for later GitHub user lookup
              if (email && email.includes('@')) {
                coAuthorEmails.add(email.toLowerCase());
              }
              
              // Normalize email for lookup
              const normalizedEmail = email.toLowerCase();
              
              // First check if we already have this person by email
              let found = false;
              for (const [login, data] of contributorsMap.entries()) {
                if (data.email && data.email.toLowerCase() === normalizedEmail) {
                  data.contributions += 1;
                  data.repositories.add(repo.name);
                  found = true;
                  console.log(`Updated existing contributor by email: ${login}`);
                  break;
                }
              }
              
              if (!found) {
                // Generate a unique username for this co-author
                let username = name;
                if (!username || username.trim() === '') {
                  // Extract username from email
                  username = email.split('@')[0];
                }
                
                // Remove spaces and special characters
                username = username.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
                
                if (username.length < 2) {
                  username = `contributor-${contributorsMap.size + 1}`;
                }
                
                // Check if we already have this username
                let finalUsername = username;
                let counter = 1;
                while (contributorsMap.has(finalUsername)) {
                  finalUsername = `${username}-${counter}`;
                  counter++;
                }
                
                contributorsMap.set(finalUsername, {
                  login: name || email.split('@')[0],
                  email: email,
                  avatar_url: `https://github.com/identicons/${finalUsername}.png`,
                  html_url: `mailto:${email}`,
                  contributions: 1,
                  lines_contributed: 0,
                  repositories: new Set([repo.name]),
                  pending_github_lookup: true  // Mark for GitHub lookup
                });
                
                console.log(`Added new co-author as contributor: ${finalUsername}`);
              }
            }
          }
          
          console.log(`Found ${coAuthorCount} co-author mentions in ${commitsWithCoAuthors} commits from ${repo.name}`);
          
          if (coAuthorCount > 0) {
            repoStats.withCoAuthors++;
          }
          
          // Get language breakdown
          console.log(`Fetching languages for ${repo.name}...`);
          const languages = await apiRequest(octokit.rest.repos.listLanguages, {
            owner: ORG_NAME,
            repo: repo.name
          });
          
          repoMetrics.languages = languages.data;
          
          // Calculate lines of code
          let repoLines = 0;
          for (const [language, bytes] of Object.entries(languages.data)) {
            const factor = 0.05; // ~20 bytes per line - simplified for debugging
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
          
          console.log(`${repo.name} has approximately ${repoLines.toLocaleString()} lines of code`);
          
        } catch (error) {
          console.error(`Error processing ${repo.name}:`, error.message);
          if (error.response) {
            console.error(`Status: ${error.response.status} ${error.response.data?.message || ''}`);
          }
        }
        
        metrics.repositories.push(repoMetrics);
      }
      
      // Add small delay between batches
      if (i + MAX_BATCH_SIZE < allReposInProcessOrder.length) {
        console.log("Adding delay between repos...");
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    // Save co-author debugging info
    fs.writeFileSync(coauthorLogPath, JSON.stringify(allCoauthors, null, 2));
    console.log(`Saved co-author debug info to ${coauthorLogPath}`);
    
    // Log repository stats
    console.log(`Repository stats: ${repoStats.processed}/${repoStats.total} processed, ${repoStats.withContributors} with contributors, ${repoStats.withCoAuthors} with co-authors`);
    
    // Now look up GitHub users by email
    console.log(`Found ${coAuthorEmails.size} unique co-author emails to look up`);
    console.log(`Starting GitHub user lookup for co-author emails...`);
    
    // Lookup GitHub users by email in batches
    const emailToGitHubUser = await batchLookupUsersByEmail([...coAuthorEmails]);
    
    console.log(`Successfully looked up ${emailToGitHubUser.size} GitHub users by email`);
    
    // Update contributors with GitHub info if we found matching users
    for (const [login, data] of contributorsMap.entries()) {
      if (data.email && data.pending_github_lookup) {
        const githubUser = emailToGitHubUser.get(data.email.toLowerCase());
        
        if (githubUser) {
          console.log(`Updating contributor "${login}" with GitHub info from email lookup: ${githubUser.login}`);
          
          // Update with GitHub info
          data.github_login = githubUser.login;
          data.avatar_url = githubUser.avatar_url;
          data.html_url = githubUser.html_url;
          
          // Add a flag to indicate this was matched by email
          data.matched_by_email = true;
          
          // Remove the pending flag
          delete data.pending_github_lookup;
        }
      }
    }
    
    // Now check if any contributors with GitHub info match other contributors by email
    // This helps with deduplication
    console.log("Looking for duplicate contributors based on email...");
    
    const loginMap = new Map(); // Maps emails to logins
    const duplicates = [];
    
    // First, build a map of emails to logins
    for (const [login, data] of contributorsMap.entries()) {
      if (data.email) {
        const normalizedEmail = data.email.toLowerCase();
        if (!loginMap.has(normalizedEmail)) {
          loginMap.set(normalizedEmail, []);
        }
        loginMap.get(normalizedEmail).push(login);
      }
    }
    
    // Find duplicates
    for (const [email, logins] of loginMap.entries()) {
      if (logins.length > 1) {
        console.log(`Found duplicate contributors with email ${email}: ${logins.join(', ')}`);
        duplicates.push({
          email,
          logins
        });
      }
    }
    
    // Merge duplicates
    for (const { email, logins } of duplicates) {
      // Find the "best" login to keep
      let primaryLogin = logins[0];
      
      // Prefer logins with GitHub info
      for (const login of logins) {
        const data = contributorsMap.get(login);
        if (data.github_login || !data.pending_github_lookup) {
          primaryLogin = login;
          break;
        }
      }
      
      console.log(`Merging duplicates for ${email} into primary login: ${primaryLogin}`);
      
      const primaryData = contributorsMap.get(primaryLogin);
      
      // Merge data from other logins
      for (const login of logins) {
        if (login === primaryLogin) continue;
        
        const data = contributorsMap.get(login);
        
        // Merge contributions
        primaryData.contributions += data.contributions;
        
        // Merge repositories
        for (const repo of data.repositories) {
          primaryData.repositories.add(repo);
        }
        
        // Prefer GitHub info if available
        if (data.github_login && !primaryData.github_login) {
          primaryData.github_login = data.github_login;
          primaryData.avatar_url = data.avatar_url;
          primaryData.html_url = data.html_url;
          primaryData.matched_by_email = true;
        }
        
        // Remove the duplicate
        contributorsMap.delete(login);
      }
      
      console.log(`After merging, ${primaryLogin} has ${primaryData.contributions} contributions in ${primaryData.repositories.size} repos`);
    }
    
    // Convert contributors map to array and sort by contributions
    const allContributors = Array.from(contributorsMap.values())
      .map(c => ({
        ...c,
        email: c.email || null, // Include email for debugging
        repositories: Array.from(c.repositories)
      }))
      .sort((a, b) => b.contributions - a.contributions);
    
    // Log all contributors for debugging
    console.log("All contributors after deduplication:");
    allContributors.forEach((c, i) => {
      console.log(`${i+1}. ${c.login}: ${c.contributions} contributions in ${c.repositories.length} repos`);
      if (c.github_login) {
        console.log(`   GitHub: ${c.github_login}`);
      }
      if (c.email) {
        console.log(`   Email: ${c.email}`);
      }
    });
    
    // Save deduplication info for debugging
    fs.writeFileSync(path.join(OUTPUT_DIR, 'deduplication-info.json'), JSON.stringify(duplicates, null, 2));
    
    metrics.stats.contributors.total = allContributors.length;
    metrics.stats.contributors.top = allContributors.slice(0, 20).map(c => {
      // Remove email and internal fields from final output
      const { email, pending_github_lookup, matched_by_email, ...rest } = c;
      return rest;
    });
    
    console.log(`Found ${allContributors.length} unique contributors after deduplication`);
    console.log(`Total commits: ${metrics.stats.totalCommits}`);
    console.log(`Total lines of code: ${metrics.stats.linesOfCode}`);
    
    // Add additional stats about GitHub user lookups
    metrics.stats.coauthor_processing = {
      total_coauthor_emails: coAuthorEmails.size,
      github_users_found: emailToGitHubUser.size,
      duplicates_merged: duplicates.length
    };
    
    // Save metrics to file
    console.log(`Saving metrics to ${OUTPUT_FILE}...`);
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(metrics, null, 2));
    
    // Also save raw contributor data for debugging
    fs.writeFileSync(path.join(OUTPUT_DIR, 'contributors-raw.json'), JSON.stringify(allContributors, null, 2));
    
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
    console.log(`API Requests made: ${totalRequests}`);
    console.log(`Rate limit remaining: ${remainingRequests}`);
    
  } catch (error) {
    console.error('Error collecting metrics:', error);
    process.exit(1);
  }
}

// Run the metrics collection
collectMetrics();
