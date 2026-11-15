; يفتح جدار حماية ويندوز لمراسلة المحل عند التثبيت (TCP 4800 للمراسلة، UDP 4801 لاكتشاف المركز)
!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Shop Messenger"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="Shop Messenger" dir=in action=allow protocol=TCP localport=4800'
  nsExec::Exec 'netsh advfirewall firewall add rule name="Shop Messenger" dir=in action=allow protocol=UDP localport=4801'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Shop Messenger"'
!macroend
