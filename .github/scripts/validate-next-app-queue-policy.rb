# frozen_string_literal: true

require "yaml"

ROOT = File.expand_path("../..", __dir__)

def load_yaml(path)
  YAML.safe_load(File.read(File.join(ROOT, path)), aliases: false)
end

def one_step(steps, label, &block)
  matches = steps.select(&block)
  raise "Expected one #{label}, found #{matches.length}" unless matches.length == 1

  matches.first
end

def expression(value, label)
  raise "Missing expression for #{label}" unless value.is_a?(String)

  value.sub(/\A\s*\$\{\{\s*/, "").sub(/\s*\}\}\s*\z/, "").strip
end

workflow = load_yaml(".github/workflows/next-app-v2.yaml")
jobs = workflow.fetch("jobs")
build_dev_step = one_step(jobs.fetch("build-dev").fetch("steps"), "build-dev action") do |step|
  step.fetch("uses", "").include?("/actions/build-next-app@")
end

action = load_yaml("actions/build-next-app/action.yaml")
action_steps = action.fetch("runs").fetch("steps")
cdn_step = one_step(action_steps, "CDN upload step") do |step|
  step.fetch("uses", "").include?("/cdn-upload/")
end
docker_step = one_step(action_steps, "Docker push step") do |step|
  step.fetch("uses", "").include?("docker-build-push")
end

queue_gates = {
  "build-dev artifact publication" => build_dev_step.fetch("with").fetch("publish-artifacts"),
  "deploy-dev job" => jobs.fetch("deploy-dev")["if"],
  "CDN upload" => cdn_step["if"],
  "Docker push" => docker_step["if"]
}

merge_group_guard = /github\.event_name\s*!=\s*(['"])merge_group\1/
queue_branch_guard = /!\s*startsWith\(\s*github\.ref\s*,\s*(['"])refs\/heads\/gh-readonly-queue\/\1\s*\)/
publication_input_guard = /inputs\.publish-artifacts\s*==\s*(['"])true\1/

queue_gates.each do |label, value|
  gate = expression(value, label)
  raise "#{label} does not block merge_group" unless gate.match?(merge_group_guard)
  raise "#{label} does not block queue branch pushes" unless gate.match?(queue_branch_guard)
end

{
  "CDN upload" => cdn_step["if"],
  "Docker push" => docker_step["if"]
}.each do |label, value|
  gate = expression(value, label)
  raise "#{label} does not honor publish-artifacts" unless gate.match?(publication_input_guard)
end

puts "Next.js merge queue policy is valid"
