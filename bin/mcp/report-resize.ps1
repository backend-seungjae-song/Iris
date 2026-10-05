param(
  [Parameter(Mandatory = $true)][string]$SourcePath,
  [Parameter(Mandatory = $true)][string]$DestinationPath,
  [Parameter(Mandatory = $true)][int]$MaximumWidth
)
$ErrorActionPreference = 'Stop'
if ($MaximumWidth -lt 1) { throw 'MaximumWidth must be positive' }
Add-Type -AssemblyName System.Drawing
$image = $null; $bitmap = $null; $graphics = $null
try {
  $image = [System.Drawing.Image]::FromFile($SourcePath)
  $width = [Math]::Min($MaximumWidth, $image.Width)
  $height = [Math]::Max(1, [int][Math]::Round($image.Height * $width / $image.Width))
  $bitmap = New-Object System.Drawing.Bitmap($width, $height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.DrawImage($image, 0, 0, $width, $height)
  $bitmap.Save($DestinationPath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  if ($graphics) { $graphics.Dispose() }
  if ($bitmap) { $bitmap.Dispose() }
  if ($image) { $image.Dispose() }
}
