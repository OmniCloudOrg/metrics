# GitHub Organization Metrics

This repository contains automated tooling to collect and track metrics from a GitHub organization.

## Overview

The GitHub Action in this repository collects comprehensive metrics about your organization's repositories, including:

- Repository counts, stars, forks, and watchers
- Total lines of code across all repositories (with language breakdown)
- Contributor statistics and top contributors
- Commit counts and activity
- Pull request metrics
- Historical trend data

The data is stored as JSON files in the repository and updated daily. This allows you to:

1. Track growth and contribution patterns over time
2. Create custom dashboards using the metrics data
3. Integrate with other tools and services
4. Showcase your organization's activity

## Setup Instructions

### 1. Repository Setup

To set up this metrics collector for your organization:

1. Fork this repository or create a new one
2. Ensure the repository has a `scripts` directory and a `data` directory
3. Copy the workflow file to `.github/workflows/`
4. Copy the collection script to `scripts/`

### 2. Configure the Action

Update the workflow file to specify your organization name:

```yaml
env:
  GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  ORGANIZATION: 'YourOrgName'  # Replace with your organization name
```

### 3. Token Setup (Optional)

The action uses the default `GITHUB_TOKEN` provided by GitHub Actions, which is sufficient for public repositories. However, for higher rate limits or access to private repositories, you can create a personal access token (PAT) with the following permissions:

- `repo` - Full control of private repositories
- `read:org` - Read organization membership
- `read:user` - Read user profile data

Add this token as a repository secret named `GH_PAT`, then update the workflow to use it:

```yaml
env:
  GITHUB_TOKEN: ${{ secrets.GH_PAT }}
  ORGANIZATION: 'YourOrgName'
```

## How It Works

1. The GitHub Action runs on a daily schedule (or can be triggered manually)
2. It uses the GitHub API to collect metrics for all repositories in the organization
3. The script processes the data and generates:
   - `github-metrics.json` - The latest metrics snapshot
   - `metrics-history.json` - Historical data for trend analysis
4. The data is committed back to the repository

## Sample Output

The metrics JSON file includes:

```json
{
  "organization": "OmniCloudOrg",
  "timestamp": "2025-03-08T12:34:56Z",
  "stats": {
    "repositories": 42,
    "stars": 1500,
    "forks": 250,
    "watchers": 100,
    "openIssues": 75,
    "totalCommits": 3750,
    "linesOfCode": 125000,
    "pullRequests": {
      "open": 15,
      "closed": 120,
      "merged": 450
    },
    "contributors": {
      "total": 65,
      "top": [
        {
          "login": "topContributor",
          "avatar_url": "https://github.com/topContributor.png",
          "html_url": "https://github.com/topContributor",
          "contributions": 750,
          "repositories": ["repo1", "repo2", "repo3"]
        },
        // ... more contributors
      ]
    },
    "languages": {
      "JavaScript": 5000000,
      "TypeScript": 3000000,
      "Python": 2000000
    }
  },
  "repositories": [
    {
      "name": "repo1",
      "description": "Repository description",
      "stars": 500,
      // ... more repo stats
    },
    // ... more repositories
  ]
}
```

## Using the Data

Here are some ways to use the collected metrics:

1. **Create a Metrics Dashboard**: Use the JSON data to build a dashboard website
2. **Track Growth**: Analyze the history file to monitor organization growth
3. **Contributor Recognition**: Identify and recognize top contributors
4. **Status Badge**: Create a badge showing stars or contributor count
5. **Integration**: Feed the data into other systems for reporting

## Troubleshooting

If you encounter issues with the metrics collection:

1. Check the Action logs for error messages
2. Ensure your token has sufficient permissions
3. Be aware of GitHub API rate limits
4. For large organizations, try reducing the data collection scope

## License

This project is licensed under the MIT License - see the LICENSE file for details.
