import type Dockerode from "dockerode";

export async function ensureSubAgentImage(docker: Dockerode, imageName: string): Promise<void> {
  try {
    await docker.getImage(imageName).inspect();
    console.log(`[imageBuilder] ${imageName} found.`);
  } catch {
    throw new Error(
      `[imageBuilder] Sub-agent image "${imageName}" not found. ` +
      `Build it with repo root as context: docker build -t ${imageName} -f sub-agent/Dockerfile .`
    );
  }
}
