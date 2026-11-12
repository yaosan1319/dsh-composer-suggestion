<#
.SYNOPSIS
Publish this bundle to GitHub as a public repository, and optionally tag a release.

.DESCRIPTION
Prepares the working tree, commits it, creates the repository through the GitHub
REST API when GITHUB_TOKEN is set, then pushes the branch and, with -Tag, pushes
a version tag that the release workflow turns into an npm publish.

Authentication: HTTP(S) remotes fall back to Git Credential Manager, which the
first push opens in a browser. Set GITHUB_TOKEN to skip that and to create the
repository without a manual step.

.PARAMETER User
GitHub user or organization that will own the repository.

.PARAMETER Repo
Repository name. Defaults to dsh-composer-suggestion.

.PARAMETER Name
Commit author name. Defaults to the existing git config.

.PARAMETER Email
Commit author email. Defaults to the existing git config.

.PARAMETER Tag
Also create and push tag v<package version>, which triggers the release workflow.

.PARAMETER Private
Create a private repository instead of a public one.

.EXAMPLE
$env:GITHUB_TOKEN = 'ghp_...'
./publish.ps1 -User myname -Name "My Name" -Email me@example.com -Tag
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$User,
  [string]$Repo = 'dsh-composer-suggestion',
  [string]$Name,
  [string]$Email,
  [switch]$Tag,
  [switch]$Private
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $root
try {
  if ($Name) { git config user.name $Name }
  if ($Email) { git config user.email $Email }
  $authorName = git config user.name 2>$null
  $authorEmail = git config user.email 2>$null
  if (-not $authorName -or -not $authorEmail) {
    throw 'Set a commit identity first: pass -Name and -Email, or run git config --global user.name/user.email.'
  }

  if (-not (Test-Path (Join-Path $root '.git'))) {
    git init -b main | Out-Null
    Write-Host 'initialized repository'
  }

  git add -A
  $pending = git status --porcelain
  if ($pending) {
    $version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
    git commit -m "dsh-composer-suggestion $version" | Out-Null
    Write-Host 'committed working tree'
  }
  else {
    Write-Host 'nothing to commit'
  }

  $remote = "https://github.com/$User/$Repo.git"
  $existing = git remote 2>$null
  if ($existing -notcontains 'origin') {
    git remote add origin $remote
    Write-Host "remote origin -> $remote"
  }

  $token = $env:GITHUB_TOKEN
  if ($token) {
    $body = @{ name = $Repo; private = [bool]$Private; description = 'ChatGPT-style ghost continuation prompt inside the DSH composer, accepted with Tab' } | ConvertTo-Json
    try {
      Invoke-RestMethod -Uri 'https://api.github.com/user/repos' -Method Post -Headers @{
        Authorization          = "Bearer $token"
        Accept                 = 'application/vnd.github+json'
        'X-GitHub-Api-Version' = '2022-11-28'
      } -Body $body | Out-Null
      Write-Host "created repository $User/$Repo"
    }
    catch {
      Write-Host "repository creation skipped: $($_.Exception.Message)"
    }
  }
  else {
    Write-Host 'GITHUB_TOKEN not set: create the empty repository in the browser first, then the push below authenticates through Git Credential Manager.'
  }

  git push -u origin main
  Write-Host 'pushed main'

  if ($Tag) {
    $version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
    git tag -f "v$version"
    git push origin "v$version"
    Write-Host "pushed tag v$version (the release workflow publishes it to npm once NPM_TOKEN is set)"
  }

  Write-Host ''
  Write-Host "next: https://github.com/$User/$Repo"
  Write-Host 'then, to appear in the community market, open one entry pull request against awesome-dsh-plugin.'
}
finally {
  Pop-Location
}
