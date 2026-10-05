$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Iris ' + [char]0xD55C + [char]0xAE00 + ' Windows Native Test'
$form.Width = 320
$form.Height = 200
$button = New-Object System.Windows.Forms.Button
$button.Text = 'Iris Test Close'
$button.Width = 160
$button.Add_Click({ $form.Close() })
$form.Controls.Add($button)
$background = New-Object System.Windows.Forms.Form
$background.Text = 'Iris Background Dialog Test'
$background.Width = 320
$background.Height = 200
$otherButton = New-Object System.Windows.Forms.Button
$otherButton.Name = '1'
$otherButton.Text = 'Background Default'
$otherButton.Width = 160
$otherButton.Add_Click({ [Console]::Out.WriteLine('wrong-window') })
$background.Controls.Add($otherButton)
$form.Add_Shown({ $background.Show(); $form.Activate(); [Console]::Out.WriteLine('ready') })
$form.Add_FormClosed({ $background.Close() })
[System.Windows.Forms.Application]::Run($form)
