export interface ContainerVolumeDefinition {
  source: string,
  target: string,
  bindMode?: 'rw' | 'ro'
}

export interface DBRunnerContainerOptions {
  volumes?: ContainerVolumeDefinition[],
  version?: string,
}

// @todo Finish with old one PR for it
export abstract class DbRunnerAbstract {

}
