import { Config } from '@remotion/cli/config'
Config.setVideoImageFormat('png')
Config.overrideWebpackConfig((c) => c)
